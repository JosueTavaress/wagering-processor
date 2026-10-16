import { Money } from "./Money";
import { DomainError, FailureCode } from "./DomainError";
export type WalletState = {
  id: string;
  playerId: string;
  balance: Money;
  version: number;
  createdAt: Date;
  updatedAt: Date;
};
export class Wallet {
  private constructor(private readonly state: WalletState) {}
  static open(props: {
    id: string;
    playerId: string;
    initialBalance: Money;
  }): Wallet {
    if (props.initialBalance.isNegative())
      throw new DomainError(FailureCode.InvalidInitialBalance);
    return new Wallet({
      id: props.id,
      playerId: props.playerId,
      balance: props.initialBalance,
      version: 1,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  }
  static rehydrate(state: WalletState): Wallet {
    return new Wallet({
      ...state,
      createdAt: new Date(state.createdAt),
      updatedAt: new Date(state.updatedAt),
    });
  }
  get id() {
    return this.state.id;
  }
  get playerId() {
    return this.state.playerId;
  }
  get currency() {
    return this.state.balance.currency;
  }
  get balance() {
    return this.state.balance;
  }
  get version() {
    return this.state.version;
  }
  get createdAt() {
    return new Date(this.state.createdAt);
  }
  get updatedAt() {
    return new Date(this.state.updatedAt);
  }
  debit(money: Money, code: string = FailureCode.InsufficientFunds): void {
    if (!money.isPositive()) throw new DomainError(FailureCode.InvalidAmount);
    if (this.balance.isLessThan(money)) throw new DomainError(code);
    this.change(this.balance.subtract(money));
  }
  credit(money: Money): void {
    if (!money.isPositive()) throw new DomainError(FailureCode.InvalidAmount);
    this.change(this.balance.add(money));
  }
  private change(balance: Money): void {
    this.state.balance = balance;
    this.state.version++;
    this.state.updatedAt = new Date();
  }
}
