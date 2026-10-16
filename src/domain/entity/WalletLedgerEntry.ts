import { Money } from "./Money";
import { DomainError, FailureCode } from "./DomainError";
export const LedgerDirection = {
  Debit: "DEBIT",
  Credit: "CREDIT",
} as const;
export type LedgerDirection =
  (typeof LedgerDirection)[keyof typeof LedgerDirection];

export type LedgerState = {
  id: string;
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  money: Money;
  balanceBefore: Money;
  balanceAfter: Money;
  createdAt: Date;
};
export class WalletLedgerEntry {
  private constructor(private readonly state: Readonly<LedgerState>) {
    Object.freeze(state);
    Object.freeze(this);
  }
  static create(state: LedgerState): WalletLedgerEntry {
    const entry = new WalletLedgerEntry({
      ...state,
      createdAt: new Date(state.createdAt),
    });
    if (
      !state.money.isPositive() ||
      state.balanceAfter.isNegative() ||
      !entry.isBalanced()
    )
      throw new DomainError(FailureCode.UnbalancedLedger);
    return entry;
  }
  static rehydrate(state: LedgerState): WalletLedgerEntry {
    return new WalletLedgerEntry({
      ...state,
      createdAt: new Date(state.createdAt),
    });
  }
  snapshot(): Readonly<LedgerState> {
    return { ...this.state, createdAt: new Date(this.state.createdAt) };
  }
  isBalanced(): boolean {
    const s = this.state;
    return (
      s.direction === LedgerDirection.Credit
        ? s.balanceBefore.add(s.money)
        : s.balanceBefore.subtract(s.money)
    ).equals(s.balanceAfter);
  }
}
