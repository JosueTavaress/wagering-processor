import { expect, spyOn, test } from "bun:test";
import {
  GetQueueAttributesCommand,
  ReceiveMessageCommand,
} from "@aws-sdk/client-sqs";
import { WagerConsumer } from "../../src/infra/workers/WagerConsumer";
import type { SqsBroker } from "../../src/infra/messaging/SqsBroker";
import type { Database } from "../../src/infra/database/Database";
import type { ProcessWagerTransaction } from "../../src/application/process-wager-transaction/ProcessWagerTransaction";
import { telemetry } from "../../src/infra/observability/Telemetry";

function consumerWithMetric(readMetric: () => Promise<unknown>) {
  let polls = 0;
  let metricReads = 0;
  const broker = {
    url: async (name: string) => name,
    client: {
      send: async (command: unknown) => {
        if (command instanceof GetQueueAttributesCommand) {
          metricReads++;
          return readMetric();
        }
        if (command instanceof ReceiveMessageCommand) {
          polls++;
          return { Messages: [] };
        }
        throw new Error("Unexpected command");
      },
    },
  } as unknown as SqsBroker;
  return {
    consumer: new WagerConsumer(
      broker,
      {} as ProcessWagerTransaction,
      {} as Database,
    ),
    counts: () => ({ polls, metricReads }),
  };
}

const flushMetric = () =>
  new Promise<void>((resolve) => setTimeout(resolve, 0));

test("DLQ metric failure preserves the last sample and does not prevent polling", async () => {
  const previous = (await telemetry.dlqDepth.get()).values[0]!.value;
  telemetry.dlqDepth.set(7);
  try {
    const { consumer, counts } = consumerWithMetric(async () => {
      throw new Error("metric unavailable");
    });
    expect(await consumer.tick()).toBe(0);
    await flushMetric();
    expect(counts()).toEqual({ polls: 1, metricReads: 1 });
    expect((await telemetry.dlqDepth.get()).values[0]!.value).toBe(7);
  } finally {
    telemetry.dlqDepth.set(previous);
  }
});

test("DLQ metric refreshes at most every thirty seconds, including after failure", async () => {
  let now = 100000;
  const clock = spyOn(Date, "now").mockImplementation(() => now);
  let fail = true;
  const { consumer, counts } = consumerWithMetric(async () => {
    if (fail) throw new Error("unavailable");
    return {
      Attributes: {
        ApproximateNumberOfMessages: "2",
        ApproximateNumberOfMessagesNotVisible: "3",
      },
    };
  });
  const previous = (await telemetry.dlqDepth.get()).values[0]!.value;
  try {
    await consumer.tick();
    await flushMetric();
    now += 29999;
    await consumer.tick();
    expect(counts()).toEqual({ polls: 2, metricReads: 1 });
    fail = false;
    now++;
    await consumer.tick();
    await flushMetric();
    expect(counts()).toEqual({ polls: 3, metricReads: 2 });
    expect((await telemetry.dlqDepth.get()).values[0]!.value).toBe(5);
  } finally {
    clock.mockRestore();
    telemetry.dlqDepth.set(previous);
  }
});

test("an outstanding DLQ metric request neither blocks polling nor overlaps another refresh", async () => {
  let finish!: (value: unknown) => void;
  const pending = new Promise((resolve) => {
    finish = resolve;
  });
  const { consumer, counts } = consumerWithMetric(() => pending);
  const clock = spyOn(Date, "now").mockReturnValue(100000);
  try {
    await consumer.tick();
    clock.mockReturnValue(200000);
    await consumer.tick();
    expect(counts()).toEqual({ polls: 2, metricReads: 1 });
  } finally {
    finish({ Attributes: {} });
    await flushMetric();
    clock.mockRestore();
  }
});
