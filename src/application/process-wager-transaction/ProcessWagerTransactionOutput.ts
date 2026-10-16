import { MoneyProps } from "../../domain/entity/Money";
export type ProcessWagerTransactionOutput = {
  transactionId: string;
  balance: MoneyProps | undefined;
  idempotentReplay: boolean;
} & (
  | { status: "PROCESSED" }
  | { status: "PENDING" | "PENDING_REFERENCE" }
  | { status: "REJECTED" | "FAILED"; failureCode: string }
);
