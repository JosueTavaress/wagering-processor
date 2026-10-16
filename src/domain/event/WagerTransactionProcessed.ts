import { IntegrationEvent, IntegrationEventProps } from "./IntegrationEvent";
import { MoneyProps } from "../entity/Money";
export type WagerTransactionProcessedData = {
  transactionId: string;
  walletId: string;
  status?: string;
  failureCode?: string;
  money: MoneyProps;
  balance: MoneyProps;
  walletVersion: number;
};
export class WagerTransactionProcessed extends IntegrationEvent<WagerTransactionProcessedData> {
  readonly eventType = "WagerTransactionProcessed";
  readonly version = 1;
  private constructor(
    props: IntegrationEventProps<WagerTransactionProcessedData>,
  ) {
    super(props);
  }
  static create(props: IntegrationEventProps<WagerTransactionProcessedData>) {
    return new WagerTransactionProcessed(props);
  }
}
