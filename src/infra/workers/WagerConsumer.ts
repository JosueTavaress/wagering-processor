import { randomUUID } from "node:crypto";
import {
  ReceiveMessageCommand,
  GetQueueAttributesCommand,
  DeleteMessageCommand,
  ChangeMessageVisibilityCommand,
  Message,
} from "@aws-sdk/client-sqs";
import { SqsBroker } from "../messaging/SqsBroker";
import { Database } from "../database/Database";
import { ProcessWagerTransaction } from "../../application/process-wager-transaction/ProcessWagerTransaction";
import { messageSchema } from "../http/Validation";
import { hash } from "../../application/process-wager-transaction/CanonicalPayload";
import { readRecoveryConfig } from "../RecoveryConfig";
import { classifyConsumerFailure } from "./ConsumerFailure";
import { telemetry } from "../observability/Telemetry";
export class WagerConsumer {
  private readonly config = readRecoveryConfig();
  constructor(
    private readonly broker: SqsBroker,
    private readonly process: ProcessWagerTransaction,
    private readonly db: Database,
  ) {}
  async tick() {
    const stats = await this.broker.client.send(
      new GetQueueAttributesCommand({
        QueueUrl: await this.broker.url("wager-transactions-dlq.fifo"),
        AttributeNames: [
          "ApproximateNumberOfMessages",
          "ApproximateNumberOfMessagesNotVisible",
        ],
      }),
    );
    telemetry.dlqDepth.set(
      Number(stats.Attributes?.ApproximateNumberOfMessages ?? 0) +
        Number(stats.Attributes?.ApproximateNumberOfMessagesNotVisible ?? 0),
    );
    const url = await this.broker.url("wager-transactions.fifo");
    const response = await this.broker.client.send(
      new ReceiveMessageCommand({
        QueueUrl: url,
        MaxNumberOfMessages: 1,
        WaitTimeSeconds: 2,
        VisibilityTimeout: this.config.queueVisibilitySeconds,
        MessageSystemAttributeNames: ["ApproximateReceiveCount"],
      }),
    );
    for (const message of response.Messages ?? [])
      await this.handle(url, message);
    return response.Messages?.length ?? 0;
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
          consumerName: "wager-v1",
          messageId: envelope.messageId,
          payloadHash: hash(envelope.data),
        },
      });
      identifiers.transactionId = result.transactionId;
      if (result.idempotentReplay) telemetry.duplicates.inc();
      else telemetry.transactions.inc({ status: result.status });
      telemetry.log("wager_consumed", {
        correlationId: envelope.messageId,
        messageId: envelope.messageId,
        transactionId: result.transactionId,
        walletId: envelope.data.walletId,
        providerId: envelope.data.providerId,
        status: result.status,
      });
      if (
        process.env.NODE_ENV === "test" &&
        process.env.CRASH_AFTER_COMMIT_MESSAGE_ID === envelope.messageId
      )
        process.kill(process.pid, "SIGKILL");
      // Drain visibility changes before ack so no renewal outlives this message.
      await heartbeat.stop();
      // A returned result means the financial SQL commit has completed.
      await this.broker.client.send(
        new DeleteMessageCommand({ QueueUrl: url, ReceiptHandle: receipt }),
      );
    } catch (error) {
      const failure = classifyConsumerFailure(error);
      const attempts = Number(message.Attributes?.ApproximateReceiveCount ?? 1);
      if (!failure.retryable || attempts >= this.config.maxReceiveCount) {
        const reason = failure.reason;
        // DLQ first, then delete. Crashes can duplicate the dead letter, never silently lose it.
        await this.broker.publish(
          message.Body ?? "{}",
          "dead-letter",
          message.MessageId ?? randomUUID(),
          "wager-transactions-dlq.fifo",
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
        telemetry.log("wager_dead_letter", {
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
        telemetry.retries.inc({ component: "sqs" });
        telemetry.log("wager_retry", {
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
            VisibilityTimeout: Math.min(60, 2 ** attempts),
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
    const intervalMs = Math.max(100, Math.floor((visibility * 1000) / 3));
    let stopped = false;
    let inFlight: Promise<void> | undefined;
    const timer = setInterval(() => {
      // Skip rather than queue renewals: at most one request may be outstanding.
      if (stopped || inFlight) return;
      const controller = new AbortController();
      const timeout = setTimeout(
        () => controller.abort(),
        Math.min(10000, intervalMs),
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
          telemetry.log("visibility_extension_failed", { messageId });
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
