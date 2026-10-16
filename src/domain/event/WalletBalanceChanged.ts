import { IntegrationEvent, IntegrationEventProps } from "./IntegrationEvent";
import type { LedgerDirection } from "../entity/WalletLedgerEntry";
import { MoneyProps } from "../entity/Money";
export type WalletBalanceChangedData = {
  transactionId: string;
  walletId: string;
  status?: string;
  failureCode?: string;
  money: MoneyProps;
  balance: MoneyProps;
  direction: LedgerDirection;
  balanceBefore: MoneyProps;
  balanceAfter: MoneyProps;
  walletVersion: number;
};
export class WalletBalanceChanged extends IntegrationEvent<WalletBalanceChangedData> {
  readonly eventType = "WalletBalanceChanged";
  readonly version = 1;
  private constructor(props: IntegrationEventProps<WalletBalanceChangedData>) {
    super(props);
  }
  static create(props: IntegrationEventProps<WalletBalanceChangedData>) {
    return new WalletBalanceChanged(props);
  }
}
