import { Kind, Status } from "../../domain/entity/WagerTransaction";
import type { LedgerDirection } from "../../domain/entity/WalletLedgerEntry";
import { MoneyProps } from "../../domain/entity/Money";
export type WalletView = {
  id: string;
  playerId: string;
  balance: MoneyProps;
  version: number;
};
export type LedgerView = {
  id: string;
  transactionId: string;
  direction: LedgerDirection;
  money: MoneyProps;
  balanceBefore: MoneyProps;
  balanceAfter: MoneyProps;
  createdAt: string;
};
export type TransactionView = {
  transactionId: string;
  providerId: string;
  externalTransactionId: string;
  walletId: string;
  kind: Kind;
  status: Status;
  money: MoneyProps;
  balance?: MoneyProps;
  failureCode?: string;
  referenceTransactionId?: string;
  createdAt: string;
  processedAt?: string;
};
export type ReconciliationView = {
  walletId: string;
  storedBalance: MoneyProps;
  calculatedBalance: MoneyProps;
  difference: MoneyProps;
  consistent: boolean;
  checkedEntries: number;
};
export interface WalletQueries {
  wallet(id: string): Promise<WalletView>;
  ledger(
    id: string,
    cursor: string | undefined,
    limit: number,
  ): Promise<{ entries: LedgerView[]; nextCursor: string | null }>;
  transaction(id: string): Promise<TransactionView>;
  providerTransaction(
    providerId: string,
    externalId: string,
  ): Promise<TransactionView>;
  reconcile(id: string): Promise<ReconciliationView>;
}
