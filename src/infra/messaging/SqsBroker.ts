import {
  SQSClient,
  GetQueueUrlCommand,
  GetQueueAttributesCommand,
  SendMessageCommand,
} from "@aws-sdk/client-sqs";
export class SqsBroker {
  readonly client = new SQSClient({
    region: process.env.AWS_REGION ?? "us-east-1",
    endpoint: process.env.SQS_ENDPOINT ?? "http://localhost:4566",
    credentials: {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? "test",
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? "test",
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
      "wager-transactions.fifo",
      "wager-transactions-dlq.fifo",
      "wager-events.fifo",
    ])
      await this.client.send(
        new GetQueueAttributesCommand({
          QueueUrl: await this.url(name),
          AttributeNames: ["QueueArn"],
        }),
      );
  }
  async publish(
    body: string,
    group: string,
    eventId: string,
    queue = "wager-events.fifo",
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
