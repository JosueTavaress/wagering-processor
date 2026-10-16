import { WorkerRole } from "../RecoveryConfig";
import { Counter, Gauge, Histogram, Registry } from "prom-client";
const MetricName = {
  WagerTransactionsTotal: "wager_transactions_total",
  WagerDuplicatesTotal: "wager_duplicates_total",
  WagerRetriesTotal: "wager_retries_total",
  WagerDlqTotal: "wager_dlq_total",
  WagerDlqMessages: "wager_dlq_messages",
  WagerLockConflictsTotal: "wager_lock_conflicts_total",
  WagerOutboxLagSeconds: "wager_outbox_lag_seconds",
  WagerProcessingSeconds: "wager_processing_seconds",
  WagerReconciliationDivergencesTotal: "wager_reconciliation_divergences_total",
} as const;
export const LogEvent = {
  ApiStarted: "api_started",
  ReferenceRetry: "reference_retry",
  WagerHttp: "wager_http",
  HttpInfrastructureError: "http_infrastructure_error",
  HttpInternalError: "http_internal_error",
  ReconciliationDivergence: "reconciliation_divergence",
  OutboxLeaseLost: "outbox_lease_lost",
  OutboxRetry: "outbox_retry",
  WagerConsumed: "wager_consumed",
  WagerDeadLetter: "wager_dead_letter",
  DlqMetricFailed: "dlq_metric_failed",
  WagerRetry: "wager_retry",
  VisibilityExtensionFailed: "visibility_extension_failed",
  WorkerRetry: "worker_retry",
  WorkerStarted: "worker_started",
  WorkerStopped: "worker_stopped",
} as const;
export const RetryComponent = {
  Database: "database",
  Sqs: "sqs",
  Outbox: "outbox",
  Reference: WorkerRole.Reference,
} as const;

export class Telemetry {
  readonly registry = new Registry();
  readonly transactions = new Counter({
    name: MetricName.WagerTransactionsTotal,
    help: "Committed outcomes",
    labelNames: ["status"],
    registers: [this.registry],
  });
  readonly duplicates = new Counter({
    name: MetricName.WagerDuplicatesTotal,
    help: "Persistent replays",
    registers: [this.registry],
  });
  readonly retries = new Counter({
    name: MetricName.WagerRetriesTotal,
    help: "Retry attempts",
    labelNames: ["component"],
    registers: [this.registry],
  });
  readonly dlq = new Counter({
    name: MetricName.WagerDlqTotal,
    help: "Messages sent to DLQ",
    registers: [this.registry],
  });
  readonly dlqDepth = new Gauge({
    name: MetricName.WagerDlqMessages,
    help: "Current DLQ depth including native redrive",
    registers: [this.registry],
  });
  readonly locks = new Counter({
    name: MetricName.WagerLockConflictsTotal,
    help: "Deadlock/lock timeout",
    registers: [this.registry],
  });
  readonly lag = new Gauge({
    name: MetricName.WagerOutboxLagSeconds,
    help: "Age of oldest unpublished event",
    registers: [this.registry],
  });
  readonly latency = new Histogram({
    name: MetricName.WagerProcessingSeconds,
    help: "Processing latency",
    registers: [this.registry],
  });
  readonly divergences = new Counter({
    name: MetricName.WagerReconciliationDivergencesTotal,
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
