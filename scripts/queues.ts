import {
  CreateQueueCommand,
  GetQueueAttributesCommand,
  SetQueueAttributesCommand,
} from "@aws-sdk/client-sqs";
import { SqsBroker } from "../src/infra/messaging/SqsBroker";
import { readRecoveryConfig } from "../src/infra/RecoveryConfig";
const config = readRecoveryConfig();
const broker = new SqsBroker();
try {
  for (const name of [
    "wager-transactions-dlq.fifo",
    "wager-events.fifo",
    "wager-transactions.fifo",
  ])
    await broker.client.send(
      new CreateQueueCommand({
        QueueName: (process.env.QUEUE_PREFIX ?? "") + name,
        Attributes: {
          FifoQueue: "true",
          ContentBasedDeduplication: "false",
          VisibilityTimeout: String(config.queueVisibilitySeconds),
          ReceiveMessageWaitTimeSeconds: "10",
        },
      }),
    );
  const dlq = await broker.client.send(
    new GetQueueAttributesCommand({
      QueueUrl: await broker.url("wager-transactions-dlq.fifo"),
      AttributeNames: ["QueueArn"],
    }),
  );
  await broker.client.send(
    new SetQueueAttributesCommand({
      QueueUrl: await broker.url("wager-transactions.fifo"),
      Attributes: {
        RedrivePolicy: JSON.stringify({
          deadLetterTargetArn: dlq.Attributes?.QueueArn,
          maxReceiveCount: String(config.maxReceiveCount),
        }),
      },
    }),
  );
  console.log("Queues ready");
} finally {
  broker.close();
}
