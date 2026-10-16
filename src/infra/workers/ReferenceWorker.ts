import { Database } from "../database/Database";
import { ProcessWagerTransaction } from "../../application/process-wager-transaction/ProcessWagerTransaction";
import {
  TransactionRow,
  transactionFromRow,
} from "../repository/PostgresTransactionRepository";
import { telemetry } from "../observability/Telemetry";
export class ReferenceWorker {
  constructor(
    private readonly db: Database,
    private readonly process: ProcessWagerTransaction,
  ) {}
  async tick() {
    const rows = await this.db.em
      .fork()
      .execute<
        TransactionRow[]
      >("select * from wager_transactions where status='PENDING_REFERENCE' and next_attempt_at<=now() order by next_attempt_at limit 50");
    for (const row of rows) {
      const s = transactionFromRow(row).snapshot();
      if (s.kind === "OPENING") continue;
      try {
        telemetry.retries.inc({ component: "reference" });
        const result = await this.process.execute(
          {
            providerId: s.providerId,
            externalTransactionId: s.externalTransactionId,
            idempotencyKey: s.idempotencyKey,
            walletId: s.walletId,
            playerId: s.playerId,
            roundId: s.roundId,
            gameId: s.gameId,
            kind: s.kind,
            money: s.money.toJSON(),
            referenceExternalTransactionId: s.referenceExternalTransactionId,
          },
          { correlationId: s.id, retryReference: true },
        );
        if (!result.idempotentReplay)
          telemetry.transactions.inc({ status: result.status });
      } catch (error) {
        telemetry.log("reference_retry", {
          transactionId: s.id,
          walletId: s.walletId,
          providerId: s.providerId,
          correlationId: s.id,
          errorCode: error instanceof Error ? error.name : "UNKNOWN",
        });
      }
    }
    return rows.length;
  }
}
