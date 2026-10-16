import { TransactionStatus } from "../../domain/entity/WagerTransaction";
import { MoneyProps } from "../../domain/entity/Money";
export type ProcessWagerTransactionOutput = {
  transactionId: string;
  balance: MoneyProps | undefined;
  idempotentReplay: boolean;
} & (
  | { status: typeof TransactionStatus.Processed }
  | {
      status:
        | typeof TransactionStatus.Pending
        | typeof TransactionStatus.PendingReference;
    }
  | {
      status:
        | typeof TransactionStatus.Rejected
        | typeof TransactionStatus.Failed;
      failureCode: string;
    }
);
