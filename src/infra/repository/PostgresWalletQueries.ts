import type { LedgerDirection } from "../../domain/entity/WalletLedgerEntry";
import { Database } from "../database/Database";
import {
  WalletQueries,
  TransactionView,
} from "../../application/port/WalletQueries";
import { DomainError } from "../../domain/entity/DomainError";
import { Money } from "../../domain/entity/Money";
import {
  TransactionRow,
  transactionFromRow,
} from "./PostgresTransactionRepository";
import { telemetry } from "../observability/Telemetry";
import { z } from "zod";
type WalletRow = {
  id: string;
  player_id: string;
  balance: string;
  currency: string;
  version: number;
};
type LedgerRow = {
  id: string;
  transaction_id: string;
  direction: LedgerDirection;
  amount: string;
  currency: string;
  balance_before: string;
  balance_after: string;
  created_at: Date;
  sequence: string;
};
export class PostgresWalletQueries implements WalletQueries {
  constructor(private readonly db: Database) {}
  async wallet(id: string) {
    const rows = await this.db.em
      .fork()
      .execute<WalletRow[]>("select * from wallets where id=?", [id]);
    const r = rows[0];
    if (!r) throw new DomainError("WALLET_NOT_FOUND");
    return {
      id: r.id,
      playerId: r.player_id,
      balance: Money.from({ amount: r.balance, currency: r.currency }).toJSON(),
      version: r.version,
    };
  }
  async ledger(id: string, cursor: string | undefined, limit: number) {
    await this.wallet(id);
    let after: { sequence: string; walletId: string } | undefined;
    if (cursor) {
      try {
        after = z
          .object({
            sequence: z
              .string()
              .max(19)
              .regex(/^[1-9]\d*$/)
              .refine((value) => BigInt(value) <= 9223372036854775807n),
            walletId: z.literal(id),
          })
          .parse(JSON.parse(Buffer.from(cursor, "base64url").toString()));
      } catch {
        throw new DomainError("INVALID_CURSOR");
      }
    }
    const params: unknown[] = [id];
    let predicate = "";
    if (after) {
      predicate = "and l.sequence>?::bigint";
      params.push(after.sequence);
    }
    params.push(limit + 1);
    const rows = await this.db.em.fork().execute<LedgerRow[]>(
      `select l.id,l.transaction_id,l.direction,l.amount,l.currency,
          l.balance_before,l.balance_after,l.created_at,l.sequence::text as sequence
        from wallet_ledger l where l.wallet_id=? ${predicate}
        order by l.sequence limit ?`,
      params,
    );
    const page = rows.slice(0, limit),
      last = page.at(-1);
    return {
      entries: page.map((r) => ({
        id: r.id,
        transactionId: r.transaction_id,
        direction: r.direction,
        money: Money.from({ amount: r.amount, currency: r.currency }).toJSON(),
        balanceBefore: Money.from({
          amount: r.balance_before,
          currency: r.currency,
        }).toJSON(),
        balanceAfter: Money.from({
          amount: r.balance_after,
          currency: r.currency,
        }).toJSON(),
        createdAt: new Date(r.created_at).toISOString(),
      })),
      nextCursor:
        rows.length > limit && last
          ? Buffer.from(
              JSON.stringify({ sequence: last.sequence, walletId: id }),
            ).toString("base64url")
          : null,
    };
  }

  private view(r: TransactionRow | undefined): TransactionView {
    if (!r) throw new DomainError("TRANSACTION_NOT_FOUND");
    const s = transactionFromRow(r).snapshot();
    return {
      transactionId: s.id,
      providerId: s.providerId,
      externalTransactionId: s.externalTransactionId,
      walletId: s.walletId,
      kind: s.kind,
      status: s.status,
      money: s.money.toJSON(),
      balance: s.balance?.toJSON(),
      failureCode: s.failureCode,
      referenceTransactionId: s.referenceTransactionId,
      createdAt: s.createdAt.toISOString(),
      processedAt: s.processedAt?.toISOString(),
    };
  }
  async transaction(id: string) {
    return this.view(
      (
        await this.db.em
          .fork()
          .execute<
            TransactionRow[]
          >("select * from wager_transactions where id=?", [id])
      )[0],
    );
  }
  async providerTransaction(providerId: string, externalId: string) {
    return this.view(
      (
        await this.db.em
          .fork()
          .execute<
            TransactionRow[]
          >("select * from wager_transactions where provider_id=? and external_transaction_id=?", [providerId, externalId])
      )[0],
    );
  }
  async reconcile(id: string) {
    return this.db.em.fork().transactional(async (em) => {
      const r = (
        await em.execute<WalletRow[]>(
          "select * from wallets where id=? for update",
          [id],
        )
      )[0];
      if (!r) throw new DomainError("WALLET_NOT_FOUND");
      const totals = (
        await em.execute<{ total: string; count: string }[]>(
          "select coalesce(sum(case direction when 'CREDIT' then amount else -amount end),0)::text total,count(*)::text count from wallet_ledger where wallet_id=?",
          [id],
        )
      )[0]!;
      const stored = Money.from({ amount: r.balance, currency: r.currency }),
        calculated = Money.from({ amount: totals.total, currency: r.currency }),
        difference = stored.subtract(calculated);
      if (!difference.isZero()) {
        telemetry.divergences.inc();
        telemetry.log("reconciliation_divergence", { walletId: id });
      }
      return {
        walletId: id,
        storedBalance: stored.toJSON(),
        calculatedBalance: calculated.toJSON(),
        difference: difference.toJSON(),
        consistent: difference.isZero(),
        checkedEntries: Number(totals.count),
      };
    });
  }
}
