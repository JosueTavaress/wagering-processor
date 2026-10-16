import { LedgerDirection } from "../entity/WalletLedgerEntry";
import {
  WagerTransaction,
  TransactionStatus,
  TransactionKind,
  type Kind,
} from "../entity/WagerTransaction";
import { Wallet } from "../entity/Wallet";
import { DomainError, FailureCode } from "../entity/DomainError";
export class WagerPolicy {
  static validateWallet(transaction: WagerTransaction, wallet: Wallet): void {
    const transactionState = transaction.snapshot();
    if (transactionState.playerId !== wallet.playerId)
      throw new DomainError(FailureCode.PlayerMismatch);
    if (transactionState.money.currency !== wallet.currency)
      throw new DomainError(FailureCode.CurrencyMismatch);
  }
  static validateReference(
    transaction: WagerTransaction,
    reference: WagerTransaction,
  ): void {
    this.validateReferenceIdentity(transaction, reference);
    const transactionState = transaction.snapshot();
    const referenceState = reference.snapshot();
    if (referenceState.status !== TransactionStatus.Processed)
      throw new DomainError(FailureCode.ReferenceNotProcessed);
    const allowedReferenceKinds: readonly Kind[] =
      transactionState.kind === TransactionKind.Rollback
        ? [TransactionKind.Bet, TransactionKind.Win, TransactionKind.Refund]
        : [TransactionKind.Bet];
    if (!allowedReferenceKinds.includes(referenceState.kind))
      throw new DomainError(FailureCode.InvalidReferenceKind);
    if (
      transaction.requiresReference() &&
      !transactionState.money.equals(referenceState.money)
    )
      throw new DomainError(FailureCode.ReferenceAmountMismatch);
  }
  static validateReferenceIdentity(
    transaction: WagerTransaction,
    reference: WagerTransaction,
  ): void {
    const transactionState = transaction.snapshot();
    const referenceState = reference.snapshot();
    if (transactionState.id === referenceState.id)
      throw new DomainError(FailureCode.InvalidReference);
    if (
      transactionState.providerId !== referenceState.providerId ||
      transactionState.playerId !== referenceState.playerId ||
      transactionState.walletId !== referenceState.walletId ||
      transactionState.roundId !== referenceState.roundId ||
      transactionState.money.currency !== referenceState.money.currency
    )
      throw new DomainError(FailureCode.ReferenceMismatch);
  }
  static apply(
    transaction: WagerTransaction,
    wallet: Wallet,
    reference?: WagerTransaction,
  ): void {
    if (!transaction.affectsBalance()) return;
    if (transaction.ledgerDirectionFor(reference) === LedgerDirection.Credit) {
      wallet.credit(transaction.money);
      return;
    }
    wallet.debit(
      transaction.money,
      transaction.kind === TransactionKind.Rollback
        ? FailureCode.ReversalInsufficientFunds
        : FailureCode.InsufficientFunds,
    );
  }
}
