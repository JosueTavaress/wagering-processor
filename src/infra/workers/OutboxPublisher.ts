import { UnknownErrorCode } from "../InfrastructureError";
import { randomUUID } from "node:crypto";
import { Database } from "../database/Database";
import { SqsBroker } from "../messaging/SqsBroker";
import {
  telemetry,
  LogEvent,
  RetryComponent,
} from "../observability/Telemetry";
import { OutboxMessage } from "../../domain/entity/OutboxMessage";
import {
  readRecoveryConfig,
  HeartbeatPolicy,
  RuntimeEnvironment,
  ProcessSignal,
} from "../RecoveryConfig";
type ClaimedMessage = {
  id: string;
  aggregate_id: string;
  event_type: string;
  payload: Record<string, unknown>;
  occurred_at: Date;
  attempts: number;
  next_attempt_at: Date;
};

export class OutboxPublisher {
  private readonly config = readRecoveryConfig();
  constructor(
    private readonly db: Database,
    private readonly broker: SqsBroker,
  ) {}

  async tick() {
    const leaseToken = randomUUID();
    const messages = await this.claimDueMessages(leaseToken);
    for (const row of messages)
      await this.publishClaimedMessage({ row, leaseToken });
    await this.updateLagMetric();
    return messages.length;
  }

  private claimDueMessages(leaseToken: string): Promise<ClaimedMessage[]> {
    return this.db.em.fork().transactional((entityManager) =>
      entityManager.execute<ClaimedMessage[]>(
        `with due as (
          select id from outbox
          where published_at is null and next_attempt_at<=now()
            and (lease_until is null or lease_until<now())
          order by occurred_at for update skip locked limit 1
        ) update outbox o
          set lease_token=?,lease_until=now()+make_interval(secs=>?)
          from due where o.id=due.id
          returning o.id,o.aggregate_id,o.event_type,o.payload,o.occurred_at,o.attempts,o.next_attempt_at`,
        [leaseToken, this.config.outboxLeaseSeconds],
      ),
    );
  }

  private async publishClaimedMessage({
    row,
    leaseToken,
  }: {
    row: ClaimedMessage;
    leaseToken: string;
  }): Promise<void> {
    const message = OutboxMessage.rehydrate({
      id: row.id,
      aggregateId: row.aggregate_id,
      eventType: row.event_type,
      payload: row.payload,
      occurredAt: new Date(row.occurred_at),
      attempts: row.attempts,
      nextAttemptAt: new Date(row.next_attempt_at),
    });
    const lease = this.keepLeaseAlive({ messageId: row.id, leaseToken });
    try {
      await this.broker.publish(
        JSON.stringify(row.payload),
        row.aggregate_id,
        row.id,
      );
      if (
        process.env.NODE_ENV === RuntimeEnvironment.Test &&
        process.env.CRASH_AFTER_PUBLISH === "1"
      )
        process.kill(process.pid, ProcessSignal.Kill);
      if (lease.isLost()) {
        this.logLostLease(row);
        return;
      }
      message.markPublished(new Date());
      await this.db.em
        .fork()
        .execute(
          "update outbox set published_at=?,lease_until=null,lease_token=null where id=? and lease_token=?",
          [message.snapshot().publishedAt, row.id, leaseToken],
        );
    } catch (error) {
      if (lease.isLost()) {
        this.logLostLease(row);
        return;
      }
      await this.persistRetry({ message, leaseToken, error });
    } finally {
      await lease.stop();
    }
  }

  private keepLeaseAlive({
    messageId,
    leaseToken,
  }: {
    messageId: string;
    leaseToken: string;
  }) {
    const leaseSeconds = this.config.outboxLeaseSeconds;
    let lost = false;
    let renewal = Promise.resolve();
    const timer = setInterval(
      () => {
        // Serialize renewals and drain them before finishing this publication.
        renewal = renewal
          .then(async () => {
            if (lost) return;
            const rows = await this.db.em.fork().execute<{ id: string }[]>(
              `update outbox set lease_until=now()+make_interval(secs=>?)
           where id=? and lease_token=? and published_at is null and lease_until>now()
           returning id`,
              [leaseSeconds, messageId, leaseToken],
            );
            lost = rows.length === 0;
          })
          .catch(() => {
            lost = true;
          });
      },
      Math.max(
        HeartbeatPolicy.minIntervalMs,
        (leaseSeconds * HeartbeatPolicy.millisecondsPerSecond) /
          HeartbeatPolicy.renewalsPerLease,
      ),
    );
    return {
      isLost: () => lost,
      stop: async () => {
        clearInterval(timer);
        await renewal;
      },
    };
  }

  private logLostLease(row: ClaimedMessage): void {
    telemetry.log(LogEvent.OutboxLeaseLost, {
      correlationId: row.payload.correlationId,
      walletId: row.aggregate_id,
      eventId: row.id,
    });
  }

  private async persistRetry({
    message,
    leaseToken,
    error,
  }: {
    message: OutboxMessage;
    leaseToken: string;
    error: unknown;
  }): Promise<void> {
    const { payload, aggregateId } = message.snapshot();
    telemetry.retries.inc({ component: RetryComponent.Outbox });
    telemetry.log(LogEvent.OutboxRetry, {
      transactionId:
        payload.data &&
        typeof payload.data === "object" &&
        "transactionId" in payload.data
          ? payload.data.transactionId
          : null,
      walletId: aggregateId,
      correlationId: payload.correlationId,
      errorCode: error instanceof Error ? error.name : UnknownErrorCode,
    });
    message.scheduleRetry(new Date());
    const retry = message.snapshot();
    // Only the current lease owner can save its retry decision.
    await this.db.em
      .fork()
      .execute(
        "update outbox set attempts=?,next_attempt_at=?,lease_until=null,lease_token=null where id=? and lease_token=?",
        [retry.attempts, retry.nextAttemptAt, retry.id, leaseToken],
      );
  }

  private async updateLagMetric(): Promise<void> {
    const rows = await this.db.em
      .fork()
      .execute<
        { age: string }[]
      >("select coalesce(extract(epoch from now()-min(occurred_at)),0)::text age from outbox where published_at is null");
    telemetry.lag.set(Math.max(0, Number(rows[0]?.age ?? 0)));
  }
}
