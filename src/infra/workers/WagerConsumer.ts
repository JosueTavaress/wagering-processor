import {
  QueueName,
  WagerConsumerName,
  DeadLetterMessageGroup,
} from "../messaging/MessagingContract";
import { randomUUID } from "node:crypto";
import {
  ReceiveMessageCommand,
  GetQueueAttributesCommand,
  DeleteMessageCommand,
  ChangeMessageVisibilityCommand,
  Message,
  QueueAttributeName,
  MessageSystemAttributeName,
} from "@aws-sdk/client-sqs";
import { SqsBroker } from "../messaging/SqsBroker";
import { Database } from "../database/Database";
import { ProcessWagerTransaction } from "../../application/process-wager-transaction/ProcessWagerTransaction";
import { messageSchema } from "../http/Validation";
import { hash } from "../../application/process-wager-transaction/CanonicalPayload";
import {
  readRecoveryConfig,
  HeartbeatPolicy,
  RuntimeEnvironment,
  ProcessSignal,
} from "../RecoveryConfig";
import {
  infrastructureErrorCode,
  UnknownErrorCode,
} from "../InfrastructureError";
import { classifyConsumerFailure } from "./ConsumerFailure";
import {
  telemetry,
  LogEvent,
  RetryComponent,
} from "../observability/Telemetry";
const ConsumerPolicy = {
  dlqMetricIntervalMs: 30000,
  dlqMetricTimeoutMs: 1000,
  messagesPerPoll: 1,
  pollWaitSeconds: 2,
  maxRetryDelaySeconds: 60,
} as const;

export class WagerConsumer {
  private readonly config = readRecoveryConfig();
  private nextDlqMetricAt = 0;
  private dlqMetricInFlight = false;
  constructor(
    private readonly broker: SqsBroker,
    private readonly process: ProcessWagerTransaction,
    private readonly db: Database,
  ) {}
  async tick() {
    void this.refreshDlqDepthIfDue();
    const url = await this.broker.url(QueueName.Transactions);
    const response = await this.broker.client.send(
      new ReceiveMessageCommand({
        QueueUrl: url,
        MaxNumberOfMessages: ConsumerPolicy.messagesPerPoll,
        WaitTimeSeconds: ConsumerPolicy.pollWaitSeconds,
        VisibilityTimeout: this.config.queueVisibilitySeconds,
        MessageSystemAttributeNames: [
          MessageSystemAttributeName.ApproximateReceiveCount,
        ],
      }),
    );
    for (const message of response.Messages ?? [])
      await this.handle(url, message);
    return response.Messages?.length ?? 0;
  }
  private async refreshDlqDepthIfDue(): Promise<void> {
    if (this.dlqMetricInFlight || Date.now() < this.nextDlqMetricAt) return;
    this.dlqMetricInFlight = true;
    this.nextDlqMetricAt = Date.now() + ConsumerPolicy.dlqMetricIntervalMs;
    try {
      const stats = await this.broker.client.send(
        new GetQueueAttributesCommand({
          QueueUrl: await this.broker.url(QueueName.DeadLetters),
          AttributeNames: [
            QueueAttributeName.ApproximateNumberOfMessages,
            QueueAttributeName.ApproximateNumberOfMessagesNotVisible,
          ],
        }),
        { abortSignal: AbortSignal.timeout(ConsumerPolicy.dlqMetricTimeoutMs) },
      );
      telemetry.dlqDepth.set(
        Number(stats.Attributes?.ApproximateNumberOfMessages ?? 0) +
          Number(stats.Attributes?.ApproximateNumberOfMessagesNotVisible ?? 0),
      );
    } catch (error) {
      telemetry.log(LogEvent.DlqMetricFailed, {
        errorCode:
          infrastructureErrorCode(error) ??
          (error instanceof Error ? error.name : UnknownErrorCode),
      });
    } finally {
      this.dlqMetricInFlight = false;
    }
  }

  private async handle(url: string, message: Message) {
    const receipt = message.ReceiptHandle;
    if (!receipt) return;
    const heartbeat = this.startVisibilityHeartbeat(
      url,
      receipt,
      message.MessageId,
    );
    const stopTimer = telemetry.latency.startTimer();
    let identifiers: Record<string, unknown> = {
      messageId: message.MessageId,
      correlationId: message.MessageId,
    };
    try {
      const envelope = messageSchema.parse(JSON.parse(message.Body ?? ""));
      identifiers = {
        correlationId: envelope.messageId,
        messageId: envelope.messageId,
        transportMessageId: message.MessageId,
        walletId: envelope.data.walletId,
        providerId: envelope.data.providerId,
      };
      const result = await this.process.execute(envelope.data, {
        correlationId: envelope.messageId,
        causationId: envelope.messageId,
        inbox: {
          consumerName: WagerConsumerName,
          messageId: envelope.messageId,
          payloadHash: hash(envelope.data),
        },
      });
      identifiers.transactionId = result.transactionId;
      if (result.idempotentReplay) telemetry.duplicates.inc();
      else telemetry.transactions.inc({ status: result.status });
      telemetry.log(LogEvent.WagerConsumed, {
        correlationId: envelope.messageId,
        messageId: envelope.messageId,
        transactionId: result.transactionId,
        walletId: envelope.data.walletId,
        providerId: envelope.data.providerId,
        status: result.status,
      });
      if (
        process.env.NODE_ENV === RuntimeEnvironment.Test &&
        process.env.CRASH_AFTER_COMMIT_MESSAGE_ID === envelope.messageId
      )
        process.kill(process.pid, ProcessSignal.Kill);
      // Drain visibility changes before ack so no renewal outlives this message.
      await heartbeat.stop();
      // A returned result means the financial SQL commit has completed.
      await this.broker.client.send(
        new DeleteMessageCommand({ QueueUrl: url, ReceiptHandle: receipt }),
      );
    } catch (error) {
      const failure = classifyConsumerFailure(error);
      const attempts = Number(
        message.Attributes?.[
          MessageSystemAttributeName.ApproximateReceiveCount
        ] ?? 1,
      );
      if (!failure.retryable || attempts >= this.config.maxReceiveCount) {
        const reason = failure.reason;
        // DLQ first, then delete. Crashes can duplicate the dead letter, never silently lose it.
        await this.broker.publish(
          message.Body ?? "{}",
          DeadLetterMessageGroup,
          message.MessageId ?? randomUUID(),
          QueueName.DeadLetters,
        );
        await this.db.em
          .fork()
          .execute(
            "insert into failed_messages(id,message_id,reason,body_hash) values (?,?,?,?)",
            [
              randomUUID(),
              message.MessageId ?? null,
              reason,
              hash(message.Body ?? ""),
            ],
          );
        telemetry.dlq.inc();
        telemetry.log(LogEvent.WagerDeadLetter, {
          ...identifiers,
          errorCode: failure.errorCode,
          failureCode: reason,
          failureCategory: failure.category,
        });
        await heartbeat.stop();
        await this.broker.client.send(
          new DeleteMessageCommand({ QueueUrl: url, ReceiptHandle: receipt }),
        );
      } else {
        telemetry.retries.inc({ component: RetryComponent.Sqs });
        telemetry.log(LogEvent.WagerRetry, {
          ...identifiers,
          errorCode: failure.errorCode,
          failureCategory: failure.category,
        });
        // A late renewal must not overwrite the retry backoff.
        await heartbeat.stop();
        await this.broker.client.send(
          new ChangeMessageVisibilityCommand({
            QueueUrl: url,
            ReceiptHandle: receipt,
            VisibilityTimeout: Math.min(
              ConsumerPolicy.maxRetryDelaySeconds,
              2 ** attempts,
            ),
          }),
        );
      }
    } finally {
      await heartbeat.stop();
      stopTimer();
    }
  }

  private startVisibilityHeartbeat(
    url: string,
    receipt: string,
    messageId?: string,
  ) {
    const visibility = this.config.queueVisibilitySeconds;
    const intervalMs = Math.max(
      HeartbeatPolicy.minIntervalMs,
      Math.floor(
        (visibility * HeartbeatPolicy.millisecondsPerSecond) /
          HeartbeatPolicy.renewalsPerLease,
      ),
    );
    let stopped = false;
    let inFlight: Promise<void> | undefined;
    const timer = setInterval(() => {
      // Skip rather than queue renewals: at most one request may be outstanding.
      if (stopped || inFlight) return;
      const controller = new AbortController();
      const timeout = setTimeout(
        () => controller.abort(),
        Math.min(HeartbeatPolicy.maxRequestTimeoutMs, intervalMs),
      );
      inFlight = (async () => {
        await this.broker.client.send(
          new ChangeMessageVisibilityCommand({
            QueueUrl: url,
            ReceiptHandle: receipt,
            VisibilityTimeout: visibility,
          }),
          { abortSignal: controller.signal },
        );
      })()
        .catch(() => {
          telemetry.log(LogEvent.VisibilityExtensionFailed, { messageId });
        })
        .finally(() => {
          clearTimeout(timeout);
          inFlight = undefined;
        });
    }, intervalMs);
    return {
      stop: async () => {
        stopped = true;
        clearInterval(timer);
        await inFlight;
      },
    };
  }
}
