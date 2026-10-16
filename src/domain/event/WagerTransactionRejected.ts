import { IntegrationEvent, IntegrationEventProps } from "./IntegrationEvent";
import { MoneyProps } from "../entity/Money";
export type WagerTransactionRejectedData = {
  transactionId: string;
  walletId: string;
  status?: string;
  failureCode: string;
  money: MoneyProps;
  balance: MoneyProps;
  walletVersion: number;
};
export class WagerTransactionRejected extends IntegrationEvent<WagerTransactionRejectedData> {
  readonly eventType = "WagerTransactionRejected";
  readonly version = 1;
  private constructor(
    props: IntegrationEventProps<WagerTransactionRejectedData>,
  ) {
    super(props);
  }
  static create(props: IntegrationEventProps<WagerTransactionRejectedData>) {
    return new WagerTransactionRejected(props);
  }
}
