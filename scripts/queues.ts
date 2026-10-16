import { QueueName } from "../src/infra/messaging/MessagingContract";
import {
  CreateQueueCommand,
  GetQueueAttributesCommand,
  SetQueueAttributesCommand,
  QueueAttributeName,
} from "@aws-sdk/client-sqs";
import { SqsBroker } from "../src/infra/messaging/SqsBroker";
import { readRecoveryConfig } from "../src/infra/RecoveryConfig";
const config = readRecoveryConfig();
const broker = new SqsBroker();
try {
  for (const name of [
    QueueName.DeadLetters,
    QueueName.Events,
    QueueName.Transactions,
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
      QueueUrl: await broker.url(QueueName.DeadLetters),
      AttributeNames: [QueueAttributeName.QueueArn],
    }),
  );
  await broker.client.send(
    new SetQueueAttributesCommand({
      QueueUrl: await broker.url(QueueName.Transactions),
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
