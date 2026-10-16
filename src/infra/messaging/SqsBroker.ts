import { QueueName } from "./MessagingContract";
import {
  SQSClient,
  GetQueueUrlCommand,
  GetQueueAttributesCommand,
  SendMessageCommand,
  QueueAttributeName,
} from "@aws-sdk/client-sqs";
const localSqsDefaults = {
  region: "us-east-1",
  endpoint: "http://localhost:4566",
  accessKeyId: "test",
  secretAccessKey: "test",
} as const;
export class SqsBroker {
  readonly client = new SQSClient({
    region: process.env.AWS_REGION ?? localSqsDefaults.region,
    endpoint: process.env.SQS_ENDPOINT ?? localSqsDefaults.endpoint,
    credentials: {
      accessKeyId:
        process.env.AWS_ACCESS_KEY_ID ?? localSqsDefaults.accessKeyId,
      secretAccessKey:
        process.env.AWS_SECRET_ACCESS_KEY ?? localSqsDefaults.secretAccessKey,
    },
    maxAttempts: 3,
  });
  private urls = new Map<string, string>();
  async url(name: string) {
    const known = this.urls.get(name);
    if (known) return known;
    const r = await this.client.send(
      new GetQueueUrlCommand({
        QueueName: (process.env.QUEUE_PREFIX ?? "") + name,
      }),
    );
    if (!r.QueueUrl) throw new Error("QUEUE_NOT_FOUND");
    this.urls.set(name, r.QueueUrl);
    return r.QueueUrl;
  }
  async ready() {
    for (const name of [
      QueueName.Transactions,
      QueueName.DeadLetters,
      QueueName.Events,
    ])
      await this.client.send(
        new GetQueueAttributesCommand({
          QueueUrl: await this.url(name),
          AttributeNames: [QueueAttributeName.QueueArn],
        }),
      );
  }
  async publish(
    body: string,
    group: string,
    eventId: string,
    queue: string = QueueName.Events,
  ) {
    await this.client.send(
      new SendMessageCommand({
        QueueUrl: await this.url(queue),
        MessageBody: body,
        MessageGroupId: group,
        MessageDeduplicationId: eventId,
      }),
    );
  }
  close() {
    this.client.destroy();
  }
}
