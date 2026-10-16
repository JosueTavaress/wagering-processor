import { Database } from "./Database";
import {
  type UnitOfWork,
  type TransactionContext,
} from "../../application/port/UnitOfWork";
import { PostgresWalletRepository } from "../repository/PostgresWalletRepository";
import { PostgresTransactionRepository } from "../repository/PostgresTransactionRepository";
import {
  infrastructureErrorCode,
  PostgresErrorCode,
} from "../InfrastructureError";
import { InboxMessage } from "../../domain/entity/InboxMessage";
import { DomainError, FailureCode } from "../../domain/entity/DomainError";
import { telemetry, RetryComponent } from "../observability/Telemetry";
const TransactionRetryPolicy = {
  maxRetries: 3,
  initialDelayMs: 25,
  jitterMs: 25,
} as const;

const retryableTransactionCodes: ReadonlySet<string> = new Set([
  PostgresErrorCode.Deadlock,
  PostgresErrorCode.LockNotAvailable,
  PostgresErrorCode.SerializationFailure,
]);
export class PostgresUnitOfWork implements UnitOfWork {
  constructor(private readonly db: Database) {}
  async run<T>(work: (context: TransactionContext) => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.db.em.fork().transactional(async (em) => {
          await em.execute("set local lock_timeout='3s'");
          await em.execute("set local statement_timeout='10s'");
          return work({
            wallets: new PostgresWalletRepository(em),
            transactions: new PostgresTransactionRepository(em),
            ledger: {
              append: async (entry) => {
                const s = entry.snapshot();
                await em.execute(
                  "insert into wallet_ledger(id,wallet_id,transaction_id,direction,amount,currency,balance_before,balance_after,created_at) values (?,?,?,?,?,?,?,?,?)",
                  [
                    s.id,
                    s.walletId,
                    s.transactionId,
                    s.direction,
                    s.money.toString(),
                    s.money.currency,
                    s.balanceBefore.toString(),
                    s.balanceAfter.toString(),
                    s.createdAt,
                  ],
                );
              },
            },
            outbox: {
              enqueue: async (message) => {
                const s = message.snapshot();
                await em.execute(
                  "insert into outbox(id,aggregate_id,event_type,payload,occurred_at,next_attempt_at) values (?,?,?,?::jsonb,?,?)",
                  [
                    s.id,
                    s.aggregateId,
                    s.eventType,
                    JSON.stringify(s.payload),
                    s.occurredAt,
                    s.nextAttemptAt,
                  ],
                );
              },
            },
            inbox: {
              record: async (ctx, transactionId) => {
                const message = InboxMessage.receive(ctx);
                message.markProcessed(new Date());
                const state = message.snapshot();
                const rows = await em.execute<
                  { payload_hash: string; transaction_id: string }[]
                >(
                  "insert into inbox(consumer_name,message_id,payload_hash,processed_at,transaction_id) values (?,?,?,?,?) on conflict(consumer_name,message_id) do update set message_id=excluded.message_id returning payload_hash,transaction_id",
                  [
                    state.consumerName,
                    state.messageId,
                    state.payloadHash,
                    state.processedAt,
                    transactionId,
                  ],
                );
                if (
                  rows[0]?.payload_hash !== ctx.payloadHash ||
                  rows[0]?.transaction_id !== transactionId
                )
                  throw new DomainError(FailureCode.InboxConflict);
              },
            },
          });
        });
      } catch (error) {
        const code = infrastructureErrorCode(error);
        if (retryableTransactionCodes.has(code ?? "")) {
          telemetry.locks.inc();
          if (attempt < TransactionRetryPolicy.maxRetries) {
            telemetry.retries.inc({ component: RetryComponent.Database });
            await Bun.sleep(
              TransactionRetryPolicy.initialDelayMs * 2 ** attempt +
                Math.random() * TransactionRetryPolicy.jitterMs,
            );
            continue;
          }
        }
        if (code === PostgresErrorCode.UniqueViolation)
          throw new DomainError(FailureCode.UniquenessConflict);
        throw error;
      }
    }
  }
}
