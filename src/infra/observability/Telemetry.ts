import { Counter, Gauge, Histogram, Registry } from "prom-client";
export class Telemetry {
  readonly registry = new Registry();
  readonly transactions = new Counter({
    name: "wager_transactions_total",
    help: "Committed outcomes",
    labelNames: ["status"],
    registers: [this.registry],
  });
  readonly duplicates = new Counter({
    name: "wager_duplicates_total",
    help: "Persistent replays",
    registers: [this.registry],
  });
  readonly retries = new Counter({
    name: "wager_retries_total",
    help: "Retry attempts",
    labelNames: ["component"],
    registers: [this.registry],
  });
  readonly dlq = new Counter({
    name: "wager_dlq_total",
    help: "Messages sent to DLQ",
    registers: [this.registry],
  });
  readonly dlqDepth = new Gauge({
    name: "wager_dlq_messages",
    help: "Current DLQ depth including native redrive",
    registers: [this.registry],
  });
  readonly locks = new Counter({
    name: "wager_lock_conflicts_total",
    help: "Deadlock/lock timeout",
    registers: [this.registry],
  });
  readonly lag = new Gauge({
    name: "wager_outbox_lag_seconds",
    help: "Age of oldest unpublished event",
    registers: [this.registry],
  });
  readonly latency = new Histogram({
    name: "wager_processing_seconds",
    help: "Processing latency",
    registers: [this.registry],
  });
  readonly divergences = new Counter({
    name: "wager_reconciliation_divergences_total",
    help: "Inconsistent wallets",
    registers: [this.registry],
  });
  log(event: string, fields: Record<string, unknown> = {}) {
    console.log(
      JSON.stringify({
        timestamp: new Date().toISOString(),
        event,
        correlationId: null,
        messageId: null,
        transactionId: null,
        walletId: null,
        providerId: null,
        ...fields,
      }),
    );
  }
}
export const telemetry = new Telemetry();
