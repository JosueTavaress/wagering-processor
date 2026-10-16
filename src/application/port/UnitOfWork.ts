import { WalletRepository } from "../../domain/repository/WalletRepository";
import { TransactionRepository } from "../../domain/repository/TransactionRepository";
import { WalletLedgerEntry } from "../../domain/entity/WalletLedgerEntry";
import { OutboxMessage } from "../../domain/entity/OutboxMessage";
export type InboxContext = {
  messageId: string;
  consumerName: string;
  payloadHash: string;
};
export interface TransactionContext {
  wallets: WalletRepository;
  transactions: TransactionRepository;
  ledger: { append(entry: WalletLedgerEntry): Promise<void> };
  outbox: { enqueue(message: OutboxMessage): Promise<void> };
  inbox: {
    record(context: InboxContext, transactionId: string): Promise<void>;
  };
}
export interface UnitOfWork {
  run<T>(work: (context: TransactionContext) => Promise<T>): Promise<T>;
}
