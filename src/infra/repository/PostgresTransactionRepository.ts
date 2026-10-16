import { EntityManager } from "@mikro-orm/postgresql";
import { TransactionRepository } from "../../domain/repository/TransactionRepository";
import {
  WagerTransaction,
  Kind,
  Status,
  TransactionStatus,
} from "../../domain/entity/WagerTransaction";
import { Money } from "../../domain/entity/Money";
export type TransactionRow = {
  id: string;
  provider_id: string;
  external_transaction_id: string;
  idempotency_key: string;
  payload_hash: string;
  wallet_id: string;
  player_id: string;
  round_id: string;
  game_id: string;
  kind: Kind;
  amount: string;
  currency: string;
  reference_external_transaction_id: string | null;
  reference_transaction_id: string | null;
  status: Status;
  failure_code: string | null;
  balance: string | null;
  balance_currency: string | null;
  created_at: Date;
  processed_at: Date | null;
  attempts: number;
  next_attempt_at: Date;
};
export function transactionFromRow(r: TransactionRow) {
  return WagerTransaction.rehydrate({
    id: r.id,
    providerId: r.provider_id,
    externalTransactionId: r.external_transaction_id,
    idempotencyKey: r.idempotency_key,
    payloadHash: r.payload_hash,
    walletId: r.wallet_id,
    playerId: r.player_id,
    roundId: r.round_id,
    gameId: r.game_id,
    kind: r.kind,
    money: Money.from({ amount: r.amount, currency: r.currency }),
    referenceExternalTransactionId:
      r.reference_external_transaction_id ?? undefined,
    referenceTransactionId: r.reference_transaction_id ?? undefined,
    status: r.status,
    failureCode: r.failure_code ?? undefined,
    balance:
      r.balance === null
        ? undefined
        : Money.from({ amount: r.balance, currency: r.balance_currency! }),
    createdAt: new Date(r.created_at),
    processedAt: r.processed_at ? new Date(r.processed_at) : undefined,
    attempts: r.attempts,
    nextAttemptAt: new Date(r.next_attempt_at),
  });
}
export class PostgresTransactionRepository implements TransactionRepository {
  constructor(private readonly em: EntityManager) {}
  async findIdentity(key: string, provider: string, external: string) {
    const rows = await this.em.execute<TransactionRow[]>(
      "select * from wager_transactions where idempotency_key=? or (provider_id=? and external_transaction_id=?)",
      [key, provider, external],
    );
    return rows.map(transactionFromRow);
  }
  async findReference(provider: string, external: string) {
    const rows = await this.em.execute<TransactionRow[]>(
      "select * from wager_transactions where provider_id=? and external_transaction_id=?",
      [provider, external],
    );
    return rows[0] ? transactionFromRow(rows[0]) : undefined;
  }
  async hasReversal(id: string, kind: Kind) {
    const rows = await this.em.execute<{ id: string }[]>(
      "select id from wager_transactions where reference_transaction_id=? and kind=? and status=?",
      [id, kind, TransactionStatus.Processed],
    );
    return rows.length > 0;
  }
  async save(tx: WagerTransaction) {
    const s = tx.snapshot();
    await this.em.execute(
      `insert into wager_transactions(id,provider_id,external_transaction_id,idempotency_key,payload_hash,wallet_id,player_id,round_id,game_id,kind,amount,currency,reference_external_transaction_id,reference_transaction_id,status,failure_code,balance,balance_currency,created_at,processed_at,attempts,next_attempt_at)
 values (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) on conflict(id) do update set reference_transaction_id=excluded.reference_transaction_id,status=excluded.status,failure_code=excluded.failure_code,balance=excluded.balance,balance_currency=excluded.balance_currency,processed_at=excluded.processed_at,attempts=excluded.attempts,next_attempt_at=excluded.next_attempt_at`,
      [
        s.id,
        s.providerId,
        s.externalTransactionId,
        s.idempotencyKey,
        s.payloadHash,
        s.walletId,
        s.playerId,
        s.roundId,
        s.gameId,
        s.kind,
        s.money.toString(),
        s.money.currency,
        s.referenceExternalTransactionId ?? null,
        s.referenceTransactionId ?? null,
        s.status,
        s.failureCode ?? null,
        s.balance?.toString() ?? null,
        s.balance?.currency ?? null,
        s.createdAt,
        s.processedAt ?? null,
        s.attempts,
        s.nextAttemptAt,
      ],
    );
  }
}
