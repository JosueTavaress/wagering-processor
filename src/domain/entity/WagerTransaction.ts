import { LedgerDirection } from "./WalletLedgerEntry";
import { Money } from "./Money";
import { DomainError, FailureCode } from "./DomainError";
export const InternalProviderId = "__internal__";
export const OpeningContextId = "opening";

export const TransactionKind = {
  Opening: "OPENING",
  Bet: "BET",
  Win: "WIN",
  Loss: "LOSS",
  Refund: "REFUND",
  Rollback: "ROLLBACK",
} as const;
export type Kind = (typeof TransactionKind)[keyof typeof TransactionKind];
export const TransactionStatus = {
  Pending: "PENDING",
  PendingReference: "PENDING_REFERENCE",
  Processed: "PROCESSED",
  Rejected: "REJECTED",
  Failed: "FAILED",
} as const;
export type Status = (typeof TransactionStatus)[keyof typeof TransactionStatus];
export const ReversalKinds: readonly Kind[] = [
  TransactionKind.Refund,
  TransactionKind.Rollback,
];
export const NonReferencingKinds: readonly Kind[] = [
  TransactionKind.Bet,
  TransactionKind.Loss,
];
export const TerminalStatuses: readonly Status[] = [
  TransactionStatus.Processed,
  TransactionStatus.Rejected,
  TransactionStatus.Failed,
];
export type TransactionState = {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: Kind;
  money: Money;
  referenceExternalTransactionId?: string;
  status: Status;
  referenceTransactionId?: string;
  failureCode?: string;
  processedAt?: Date;
  createdAt: Date;
  balance?: Money;
  attempts: number;
  nextAttemptAt: Date;
};
export class WagerTransaction {
  private constructor(private readonly state: TransactionState) {}
  static create(
    props: Omit<
      TransactionState,
      "status" | "createdAt" | "attempts" | "nextAttemptAt"
    >,
  ): WagerTransaction {
    if (
      NonReferencingKinds.includes(props.kind) &&
      props.referenceExternalTransactionId
    )
      throw new DomainError(FailureCode.UnexpectedReference);
    if (props.referenceExternalTransactionId === props.externalTransactionId)
      throw new DomainError(FailureCode.InvalidReference);
    if (
      ReversalKinds.includes(props.kind) &&
      !props.referenceExternalTransactionId
    )
      throw new DomainError(FailureCode.ReferenceRequired);
    if (
      props.kind === TransactionKind.Loss
        ? !props.money.isZero()
        : !props.money.isPositive()
    )
      throw new DomainError(FailureCode.InvalidAmount);
    return new WagerTransaction({
      ...props,
      status: TransactionStatus.Pending,
      createdAt: new Date(),
      attempts: 0,
      nextAttemptAt: new Date(),
    });
  }
  static rehydrate(state: TransactionState): WagerTransaction {
    return new WagerTransaction({
      ...state,
      createdAt: new Date(state.createdAt),
      processedAt: state.processedAt ? new Date(state.processedAt) : undefined,
      nextAttemptAt: new Date(state.nextAttemptAt),
    });
  }
  snapshot(): Readonly<TransactionState> {
    return {
      ...this.state,
      createdAt: new Date(this.state.createdAt),
      processedAt: this.state.processedAt
        ? new Date(this.state.processedAt)
        : undefined,
      nextAttemptAt: new Date(this.state.nextAttemptAt),
    };
  }
  get id() {
    return this.state.id;
  }
  get status() {
    return this.state.status;
  }
  get money() {
    return this.state.money;
  }
  get kind() {
    return this.state.kind;
  }
  get failureCode() {
    return this.state.failureCode;
  }
  get referenceTransactionId() {
    return this.state.referenceTransactionId;
  }
  isTerminal(): boolean {
    return TerminalStatuses.includes(this.status);
  }
  affectsBalance(): boolean {
    return this.kind !== TransactionKind.Loss;
  }
  requiresReference(): boolean {
    return ReversalKinds.includes(this.kind);
  }
  isReferenceRetryDue(now: Date): boolean {
    return (
      this.status === TransactionStatus.PendingReference &&
      this.state.nextAttemptAt <= now
    );
  }
  matchesPayload(hash: string): boolean {
    return this.state.payloadHash === hash;
  }
  private assertMutable(): void {
    if (this.isTerminal())
      throw new DomainError(FailureCode.InvalidTransactionState);
  }
  markProcessed(
    referenceId: string | undefined,
    at: Date,
    balance: Money,
  ): void {
    this.assertMutable();
    Object.assign(this.state, {
      status: TransactionStatus.Processed,
      referenceTransactionId: referenceId,
      processedAt: new Date(at),
      balance,
    });
  }
  markPendingReference(balance: Money, now = new Date()): void {
    this.assertMutable();
    this.state.status = TransactionStatus.PendingReference;
    this.state.balance = balance;
    this.state.attempts++;
    this.state.nextAttemptAt = new Date(
      now.getTime() + Math.min(60000, 1000 * 2 ** (this.state.attempts - 1)),
    );
  }
  reject(code: string, balance: Money): void {
    this.assertMutable();
    Object.assign(this.state, {
      status: TransactionStatus.Rejected,
      failureCode: code,
      processedAt: new Date(),
      balance,
    });
  }
  fail(code: string): void {
    this.assertMutable();
    Object.assign(this.state, {
      status: TransactionStatus.Failed,
      failureCode: code,
      processedAt: new Date(),
    });
  }
  ledgerDirectionFor(reference?: WagerTransaction): LedgerDirection {
    if (this.kind === TransactionKind.Loss)
      throw new DomainError(FailureCode.NoLedgerDirection);
    if (this.kind === TransactionKind.Rollback) {
      if (!reference) throw new DomainError(FailureCode.ReferenceRequired);
      return reference.kind === TransactionKind.Bet
        ? LedgerDirection.Credit
        : LedgerDirection.Debit;
    }
    return this.kind === TransactionKind.Bet
      ? LedgerDirection.Debit
      : LedgerDirection.Credit;
  }
}
