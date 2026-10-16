import { IntegrationEvent, IntegrationEventProps } from "./IntegrationEvent";
import { MoneyProps } from "../entity/Money";
export type WagerTransactionPendingReferenceData = {
  transactionId: string;
  walletId: string;
  status?: string;
  failureCode?: string;
  money: MoneyProps;
  balance: MoneyProps;
  walletVersion: number;
};
export class WagerTransactionPendingReference extends IntegrationEvent<WagerTransactionPendingReferenceData> {
  readonly eventType = "WagerTransactionPendingReference";
  readonly version = 1;
  private constructor(
    props: IntegrationEventProps<WagerTransactionPendingReferenceData>,
  ) {
    super(props);
  }
  static create(
    props: IntegrationEventProps<WagerTransactionPendingReferenceData>,
  ) {
    return new WagerTransactionPendingReference(props);
  }
}
