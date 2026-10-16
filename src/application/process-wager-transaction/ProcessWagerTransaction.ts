import { randomUUID } from "node:crypto";
import { UnitOfWork, TransactionContext } from "../port/UnitOfWork";
import {
  ProcessWagerTransactionInput,
  ProcessingContext,
} from "./ProcessWagerTransactionInput";
import { ProcessWagerTransactionOutput } from "./ProcessWagerTransactionOutput";
import { businessHash } from "./CanonicalPayload";
import { Money } from "../../domain/entity/Money";
import { Wallet } from "../../domain/entity/Wallet";
import {
  WagerTransaction,
  ReferenceRetryPolicy,
  TransactionStatus,
} from "../../domain/entity/WagerTransaction";
import { WalletLedgerEntry } from "../../domain/entity/WalletLedgerEntry";
import { OutboxMessage } from "../../domain/entity/OutboxMessage";
import { DomainError, FailureCode } from "../../domain/entity/DomainError";
import { WagerPolicy } from "../../domain/service/WagerPolicy";
import { type IntegrationEventProps } from "../../domain/event/IntegrationEvent";
import {
  WagerTransactionProcessed,
  type WagerTransactionProcessedData,
} from "../../domain/event/WagerTransactionProcessed";
import { WagerTransactionRejected } from "../../domain/event/WagerTransactionRejected";
import { WagerTransactionPendingReference } from "../../domain/event/WagerTransactionPendingReference";
import { WalletBalanceChanged } from "../../domain/event/WalletBalanceChanged";
type TransactionWork = {
  persistence: TransactionContext;
  transaction: WagerTransaction;
  wallet: Wallet;
  context: ProcessingContext;
  entry?: WalletLedgerEntry;
};

export class ProcessWagerTransaction {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly referenceTTL: number = ReferenceRetryPolicy.defaultTtlMs,
    private readonly referenceAttempts: number = ReferenceRetryPolicy.defaultMaxAttempts,
  ) {}
  async execute(
    input: ProcessWagerTransactionInput,
    context: ProcessingContext = { correlationId: randomUUID() },
  ): Promise<ProcessWagerTransactionOutput> {
    const payloadHash = businessHash(input);
    return this.uow.run(async (persistence) => {
      // Detect an existing conflicting key even when the submitted wallet is absent.
      await this.findExistingTransaction(persistence, { input, payloadHash });
      const wallet = await persistence.wallets.lock(input.walletId);
      if (!wallet) throw new DomainError(FailureCode.WalletNotFound);

      const existing = await this.findExistingTransaction(persistence, {
        input,
        payloadHash,
      });
      const isReplay =
        existing &&
        (!context.retryReference || !existing.isReferenceRetryDue(new Date()));
      if (isReplay) {
        if (context.inbox)
          await persistence.inbox.record(context.inbox, existing.id);
        return this.toOutput(existing, true);
      }

      const transaction =
        existing ??
        WagerTransaction.create({
          ...input,
          id: randomUUID(),
          money: Money.from(input.money),
          payloadHash,
        });
      let entry: WalletLedgerEntry | undefined;
      try {
        WagerPolicy.validateWallet(transaction, wallet);
        const reference = await this.findValidatedReference({
          persistence,
          transaction,
          input,
        });
        if (input.referenceExternalTransactionId && !reference) {
          // Keep asynchronous persistence errors inside this rejection boundary.
          return await this.deferUntilReference({
            persistence,
            transaction,
            wallet,
            context,
          });
        }
        entry = this.applyFinancialOperation({
          transaction,
          wallet,
          reference,
        });
      } catch (error) {
        if (!(error instanceof DomainError) || error.isProgrammingError())
          throw error;
        transaction.reject(error.code, wallet.balance);
      }

      await this.persistOutcome({
        persistence,
        transaction,
        wallet,
        context,
        entry,
      });
      return this.toOutput(transaction, false);
    });
  }

  private async findExistingTransaction(
    persistence: TransactionContext,
    {
      input,
      payloadHash,
    }: { input: ProcessWagerTransactionInput; payloadHash: string },
  ): Promise<WagerTransaction | undefined> {
    const matches = await persistence.transactions.findIdentity(
      input.idempotencyKey,
      input.providerId,
      input.externalTransactionId,
    );
    const transaction = matches[0];
    const payloadConflicts =
      transaction && !transaction.matchesPayload(payloadHash);
    const keyConflicts =
      transaction &&
      transaction.snapshot().idempotencyKey !== input.idempotencyKey;
    if (matches.length > 1 || payloadConflicts || keyConflicts)
      throw new DomainError(FailureCode.IdempotencyConflict);
    return transaction;
  }

  private async findValidatedReference({
    persistence,
    transaction,
    input,
  }: {
    persistence: TransactionContext;
    transaction: WagerTransaction;
    input: ProcessWagerTransactionInput;
  }): Promise<WagerTransaction | undefined> {
    if (!input.referenceExternalTransactionId) return undefined;
    if (transaction.status === TransactionStatus.PendingReference)
      this.assertReferenceDeadline(transaction);
    const reference = await persistence.transactions.findReference(
      input.providerId,
      input.referenceExternalTransactionId,
    );
    if (!reference) return undefined;
    WagerPolicy.validateReferenceIdentity(transaction, reference);
    if (!reference.isTerminal()) return undefined;

    WagerPolicy.validateReference(transaction, reference);
    const alreadyReversed =
      transaction.requiresReference() &&
      (await persistence.transactions.hasReversal(
        reference.id,
        transaction.kind,
      ));
    if (alreadyReversed) throw new DomainError(FailureCode.AlreadyReversed);
    return reference;
  }

  private async deferUntilReference({
    persistence,
    transaction,
    wallet,
    context,
  }: TransactionWork): Promise<ProcessWagerTransactionOutput> {
    this.assertReferenceDeadline(transaction);

    const firstPendingNotification =
      transaction.status !== TransactionStatus.PendingReference;
    transaction.markPendingReference(wallet.balance);
    await persistence.transactions.save(transaction);
    if (context.inbox)
      await persistence.inbox.record(context.inbox, transaction.id);
    if (firstPendingNotification)
      await this.enqueueIntegrationEvents({
        persistence,
        transaction,
        wallet,
        context,
      });
    return this.toOutput(transaction, false);
  }

  private assertReferenceDeadline(transaction: WagerTransaction): void {
    const state = transaction.snapshot();
    const attemptsExhausted = state.attempts >= this.referenceAttempts;
    const referenceExpired =
      Date.now() - state.createdAt.getTime() >= this.referenceTTL;
    if (attemptsExhausted || referenceExpired)
      throw new DomainError(FailureCode.ReferenceExpired);
  }

  private applyFinancialOperation({
    transaction,
    wallet,
    reference,
  }: {
    transaction: WagerTransaction;
    wallet: Wallet;
    reference?: WagerTransaction;
  }): WalletLedgerEntry | undefined {
    const balanceBefore = wallet.balance;
    WagerPolicy.apply(transaction, wallet, reference);
    transaction.markProcessed(reference?.id, new Date(), wallet.balance);
    if (!transaction.affectsBalance()) return undefined;
    return WalletLedgerEntry.create({
      id: randomUUID(),
      walletId: wallet.id,
      transactionId: transaction.id,
      direction: transaction.ledgerDirectionFor(reference),
      money: transaction.money,
      balanceBefore,
      balanceAfter: wallet.balance,
      createdAt: new Date(),
    });
  }

  private async persistOutcome({
    persistence,
    transaction,
    wallet,
    context,
    entry,
  }: TransactionWork): Promise<void> {
    await persistence.transactions.save(transaction);
    if (entry) {
      await persistence.wallets.save(wallet);
      await persistence.ledger.append(entry);
    }
    if (context.inbox)
      await persistence.inbox.record(context.inbox, transaction.id);
    await this.enqueueIntegrationEvents({
      persistence,
      transaction,
      wallet,
      context,
      entry,
    });
  }

  private toOutput(
    transaction: WagerTransaction,
    replay: boolean,
  ): ProcessWagerTransactionOutput {
    const state = transaction.snapshot();
    const base = {
      transactionId: transaction.id,
      balance: state.balance?.toJSON(),
      idempotentReplay: replay,
    };
    if (
      state.status === TransactionStatus.Rejected ||
      state.status === TransactionStatus.Failed
    ) {
      if (!state.failureCode)
        throw new DomainError(FailureCode.InvalidTransactionState);
      return { ...base, status: state.status, failureCode: state.failureCode };
    }
    return { ...base, status: state.status };
  }
  private async enqueueIntegrationEvents({
    persistence,
    transaction,
    wallet,
    context,
    entry,
  }: TransactionWork): Promise<void> {
    const eventProps = {
      eventId: randomUUID(),
      aggregateId: wallet.id,
      occurredAt: new Date(),
      correlationId: context.correlationId,
      causationId: context.causationId,
      data: {
        transactionId: transaction.id,
        walletId: wallet.id,
        status: transaction.status,
        failureCode: transaction.failureCode,
        money: transaction.money.toJSON(),
        balance: wallet.balance.toJSON(),
        walletVersion: wallet.version,
      },
    };
    const event = this.createOutcomeEvent(transaction, eventProps);
    await persistence.outbox.enqueue(OutboxMessage.enqueue(event));
    if (!entry) return;
    const ledgerState = entry.snapshot();
    await persistence.outbox.enqueue(
      OutboxMessage.enqueue(
        WalletBalanceChanged.create({
          ...eventProps,
          eventId: randomUUID(),
          data: {
            ...eventProps.data,
            direction: ledgerState.direction,
            balanceBefore: ledgerState.balanceBefore.toJSON(),
            balanceAfter: ledgerState.balanceAfter.toJSON(),
          },
        }),
      ),
    );
  }

  private createOutcomeEvent(
    transaction: WagerTransaction,
    eventProps: IntegrationEventProps<WagerTransactionProcessedData>,
  ):
    | WagerTransactionProcessed
    | WagerTransactionRejected
    | WagerTransactionPendingReference {
    switch (transaction.status) {
      case TransactionStatus.Processed:
        return WagerTransactionProcessed.create(eventProps);
      case TransactionStatus.Rejected: {
        const failureCode = transaction.failureCode;
        if (!failureCode)
          throw new DomainError(FailureCode.InvalidTransactionState);
        return WagerTransactionRejected.create({
          ...eventProps,
          data: { ...eventProps.data, failureCode },
        });
      }
      case TransactionStatus.PendingReference:
        return WagerTransactionPendingReference.create(eventProps);
      default:
        throw new DomainError(FailureCode.InvalidTransactionState);
    }
  }
}
