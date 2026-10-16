import { test, expect } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  ReceiveMessageCommand,
  DeleteMessageCommand,
  ChangeMessageVisibilityCommand,
} from "@aws-sdk/client-sqs";
import { classifyConsumerFailure } from "../../src/infra/workers/ConsumerFailure";
import { WagerConsumer } from "../../src/infra/workers/WagerConsumer";
import { DomainError } from "../../src/domain/entity/DomainError";
import type { SqsBroker } from "../../src/infra/messaging/SqsBroker";
import type { Database } from "../../src/infra/database/Database";
import type { ProcessWagerTransaction } from "../../src/application/process-wager-transaction/ProcessWagerTransaction";

const transient = Object.assign(new Error("connection lost"), {
  code: "ECONNRESET",
});
const denied = Object.assign(new Error("sensitive detail"), {
  name: "AccessDeniedException",
  $metadata: { httpStatusCode: 403 },
});
const unknown = new Error("unclassified failure");
for (const [error, category, retryable] of [
  [transient, "transient", true],
  [denied, "permanent", false],
  [new Error("wrapper", { cause: denied }), "permanent", false],
  [Object.assign(new Error(), { code: "42601" }), "permanent", false],
  [new TypeError("bug"), "programming", false],
  [new DomainError("UNBALANCED_LEDGER"), "programming", false],
  [new DomainError("INBOX_CONFLICT"), "domain", false],
  [new SyntaxError("bad JSON"), "invalid-message", false],
  [unknown, "unknown", true],
] as const) {
  test(`consumer classifies ${category}: ${error.name}`, () => {
    expect(classifyConsumerFailure(error)).toMatchObject({
      category,
      retryable,
    });
  });
}

async function consumeFailure(error: unknown, attempts = 1, failDLQ = false) {
  const actions: string[] = [];
  let auditReason: unknown;
  const body = JSON.stringify({
    messageId: randomUUID(),
    type: "WagerTransactionRequested",
    occurredAt: new Date().toISOString(),
    data: {
      providerId: "provider-a",
      externalTransactionId: "bet",
      idempotencyKey: "provider-a:bet",
      walletId: randomUUID(),
      playerId: randomUUID(),
      roundId: "round",
      gameId: "game",
      kind: "BET",
      money: { amount: "10.00", currency: "BRL" },
    },
  });
  const broker = {
    url: async (name: string) => name,
    client: {
      send: async (command: unknown) => {
        if (command instanceof ReceiveMessageCommand)
          return {
            Messages: [
              {
                Body: body,
                ReceiptHandle: "receipt",
                MessageId: "transport",
                Attributes: { ApproximateReceiveCount: String(attempts) },
              },
            ],
          };
        if (command instanceof DeleteMessageCommand) actions.push("ack");
        if (command instanceof ChangeMessageVisibilityCommand)
          actions.push("retry");
        return {};
      },
    },
    publish: async () => {
      actions.push("dlq");
      if (failDLQ) throw new Error("DLQ unavailable");
    },
  } as unknown as SqsBroker;
  const db = {
    em: {
      fork: () => ({
        execute: async (_sql: string, params: unknown[]) => {
          actions.push("audit");
          auditReason = params[2];
        },
      }),
    },
  } as unknown as Database;
  const processor = {
    execute: async () => {
      throw error;
    },
  } as unknown as ProcessWagerTransaction;
  const completion = new WagerConsumer(broker, processor, db).tick();
  if (failDLQ) await expect(completion).rejects.toThrow("DLQ unavailable");
  else await completion;
  return { actions, auditReason };
}
test("transient and unknown failures retry without acknowledgment", async () => {
  for (const error of [transient, unknown])
    expect((await consumeFailure(error)).actions).toEqual(["retry"]);
});

test("known permanent error is dead-lettered and audited before acknowledgment", async () => {
  expect(await consumeFailure(denied)).toEqual({
    actions: ["dlq", "audit", "ack"],
    auditReason: "PERMANENT_INFRASTRUCTURE_ERROR",
  });
});

test("exhausted retries distinguish unknown failures from infrastructure", async () => {
  expect((await consumeFailure(transient, 1000)).auditReason).toBe(
    "INFRASTRUCTURE_RETRIES_EXHAUSTED",
  );
  expect((await consumeFailure(unknown, 1000)).auditReason).toBe(
    "UNKNOWN_FAILURE_RETRIES_EXHAUSTED",
  );
});

test("failed DLQ publication never acknowledges the source", async () => {
  expect((await consumeFailure(denied, 1, true)).actions).toEqual(["dlq"]);
});

test("wrapped permanent errors retain the underlying diagnostic name", () => {
  expect(
    classifyConsumerFailure(new Error("wrapper", { cause: denied })),
  ).toMatchObject({
    category: "permanent",
    errorCode: "AccessDeniedException",
  });
});

test("wrapped transient errors retain the underlying database code", () => {
  expect(
    classifyConsumerFailure(
      new Error("wrapper", {
        cause: Object.assign(new Error(), { code: "08006" }),
      }),
    ),
  ).toMatchObject({ category: "transient", errorCode: "08006" });
});

test("wrapped programming failure reaches DLQ without retry", async () => {
  expect(
    await consumeFailure(new Error("wrapper", { cause: new TypeError("bug") })),
  ).toEqual({
    actions: ["dlq", "audit", "ack"],
    auditReason: "PROGRAMMING_ERROR",
  });
});

test("one-second visibility renews before expiration and stops after completion", async () => {
  const previous = process.env.QUEUE_VISIBILITY_SECONDS;
  process.env.QUEUE_VISIBILITY_SECONDS = "1";
  const actions: string[] = [];
  let firstRenewal!: () => void;
  let release!: () => void;
  let processingStarted!: () => void;
  const renewed = new Promise<void>((resolve) => {
    firstRenewal = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started = new Promise<void>((resolve) => {
    processingStarted = resolve;
  });
  const body = JSON.stringify({
    messageId: randomUUID(),
    type: "WagerTransactionRequested",
    occurredAt: new Date().toISOString(),
    data: {
      providerId: "provider-a",
      externalTransactionId: "bet",
      idempotencyKey: "provider-a:bet",
      walletId: randomUUID(),
      playerId: randomUUID(),
      roundId: "round",
      gameId: "game",
      kind: "BET",
      money: { amount: "10.00", currency: "BRL" },
    },
  });
  let receivedAt = 0;
  let renewedAt = 0;
  const broker = {
    url: async (name: string) => name,
    client: {
      send: async (command: unknown) => {
        if (command instanceof ReceiveMessageCommand) {
          receivedAt = performance.now();
          expect(command.input.VisibilityTimeout).toBe(1);
          return {
            Messages: [
              {
                Body: body,
                ReceiptHandle: "receipt",
                MessageId: "transport",
                Attributes: { ApproximateReceiveCount: "1" },
              },
            ],
          };
        }
        if (command instanceof ChangeMessageVisibilityCommand) {
          expect(command.input.VisibilityTimeout).toBe(1);
          actions.push("heartbeat");
          renewedAt = performance.now();
          firstRenewal();
        }
        if (command instanceof DeleteMessageCommand) actions.push("ack");
        return {};
      },
    },
  } as unknown as SqsBroker;
  const processor = {
    execute: async () => {
      processingStarted();
      await gate;
      return {
        transactionId: randomUUID(),
        status: "PROCESSED",
        idempotentReplay: false,
      };
    },
  } as unknown as ProcessWagerTransaction;
  const completion = new WagerConsumer(
    broker,
    processor,
    {} as Database,
  ).tick();
  const timeout = setTimeout(() => {
    release();
    firstRenewal();
  }, 3000);
  try {
    await started;
    await renewed;
    expect(actions).toEqual(["heartbeat"]);
    expect(renewedAt - receivedAt).toBeGreaterThan(0);
    expect(renewedAt - receivedAt).toBeLessThan(900);
    release();
    await completion;
    expect(actions).toEqual(["heartbeat", "ack"]);
    const completedActions = [...actions];
    await Bun.sleep(400);
    expect(actions).toEqual(completedActions);
  } finally {
    clearTimeout(timeout);
    release();
    await completion;
    if (previous === undefined) delete process.env.QUEUE_VISIBILITY_SECONDS;
    else process.env.QUEUE_VISIBILITY_SECONDS = previous;
  }
});
