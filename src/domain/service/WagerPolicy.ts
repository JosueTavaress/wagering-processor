import { WagerTransaction } from "../entity/WagerTransaction";
import { Wallet } from "../entity/Wallet";
import { DomainError } from "../entity/DomainError";
export class WagerPolicy {
  static validateWallet(transaction: WagerTransaction, wallet: Wallet): void {
    const transactionState = transaction.snapshot();
    if (transactionState.playerId !== wallet.playerId)
      throw new DomainError("PLAYER_MISMATCH");
    if (transactionState.money.currency !== wallet.currency)
      throw new DomainError("CURRENCY_MISMATCH");
  }
  static validateReference(
    transaction: WagerTransaction,
    reference: WagerTransaction,
  ): void {
    this.validateReferenceIdentity(transaction, reference);
    const transactionState = transaction.snapshot();
    const referenceState = reference.snapshot();
    if (referenceState.status !== "PROCESSED")
      throw new DomainError("REFERENCE_NOT_PROCESSED");
    const allowedReferenceKinds =
      transactionState.kind === "ROLLBACK" ? ["BET", "WIN", "REFUND"] : ["BET"];
    if (!allowedReferenceKinds.includes(referenceState.kind))
      throw new DomainError("INVALID_REFERENCE_KIND");
    if (
      transaction.requiresReference() &&
      !transactionState.money.equals(referenceState.money)
    )
      throw new DomainError("REFERENCE_AMOUNT_MISMATCH");
  }
  static validateReferenceIdentity(
    transaction: WagerTransaction,
    reference: WagerTransaction,
  ): void {
    const transactionState = transaction.snapshot();
    const referenceState = reference.snapshot();
    if (transactionState.id === referenceState.id)
      throw new DomainError("INVALID_REFERENCE");
    if (
      transactionState.providerId !== referenceState.providerId ||
      transactionState.playerId !== referenceState.playerId ||
      transactionState.walletId !== referenceState.walletId ||
      transactionState.roundId !== referenceState.roundId ||
      transactionState.money.currency !== referenceState.money.currency
    )
      throw new DomainError("REFERENCE_MISMATCH");
  }
  static apply(
    transaction: WagerTransaction,
    wallet: Wallet,
    reference?: WagerTransaction,
  ): void {
    if (!transaction.affectsBalance()) return;
    if (transaction.ledgerDirectionFor(reference) === "CREDIT") {
      wallet.credit(transaction.money);
      return;
    }
    wallet.debit(
      transaction.money,
      transaction.kind === "ROLLBACK"
        ? "REVERSAL_INSUFFICIENT_FUNDS"
        : "INSUFFICIENT_FUNDS",
    );
  }
}
