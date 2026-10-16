import { test, expect } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  ReceiveMessageCommand,
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
} from "@aws-sdk/client-sqs";
import { WagerConsumer } from "../../src/infra/workers/WagerConsumer";
import type { SqsBroker } from "../../src/infra/messaging/SqsBroker";
import type { Database } from "../../src/infra/database/Database";
import type { ProcessWagerTransaction } from "../../src/application/process-wager-transaction/ProcessWagerTransaction";

function signal() {
  let resolve!: () => void;
  const promise = new Promise<void>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

type Outcome = "retry" | "success" | "dlq";
function scenario(
  outcome: Outcome,
  renewal: "held" | "failed" | "timeout" = "held",
  holdProcessing = false,
) {
  const previous = process.env.QUEUE_VISIBILITY_SECONDS;
  process.env.QUEUE_VISIBILITY_SECONDS = "1";
  const started = signal(),
    release = signal(),
    processed = signal(),
    allowProcessing = signal();
  const applied: string[] = [];
  let active = 0,
    maximumActive = 0,
    renewals = 0,
    completed = false,
    aborted = false;
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
    publish: async () => {
      applied.push("dlq");
    },
    client: {
      send: async (
        command: unknown,
        options?: { abortSignal?: AbortSignal },
      ) => {
        if (command instanceof ReceiveMessageCommand)
          return {
            Messages: [
              {
                Body: body,
                ReceiptHandle: "receipt",
                MessageId: "transport",
                Attributes: { ApproximateReceiveCount: "3" },
              },
            ],
          };
        if (command instanceof DeleteMessageCommand) applied.push("ack");
        if (command instanceof ChangeMessageVisibilityCommand) {
          const visibility = command.input.VisibilityTimeout!;
          if (visibility !== 1) {
            applied.push(`retry:${visibility}`);
            return {};
          }
          renewals++;
          active++;
          maximumActive = Math.max(maximumActive, active);
          started.resolve();
          try {
            if (renewal === "timeout") {
              const abortSignal = options?.abortSignal;
              if (!abortSignal)
                throw new Error("Heartbeat must have a request deadline");
              await new Promise<void>((_resolve, reject) => {
                const abort = () => {
                  aborted = true;
                  reject(
                    Object.assign(new Error("deadline reached"), {
                      name: "AbortError",
                    }),
                  );
                };
                release.promise.then(() =>
                  reject(new Error("watchdog released the pending request")),
                );
                if (abortSignal.aborted) abort();
                else
                  abortSignal.addEventListener("abort", abort, { once: true });
              });
            } else {
              // Deliberately ignore cancellation: completion ordering must still be awaited.
              await release.promise;
              if (renewal === "failed") throw new Error("network failure");
              applied.push("heartbeat:1");
            }
          } finally {
            active--;
          }
        }
        return {};
      },
    },
  } as unknown as SqsBroker;
  const db = {
    em: {
      fork: () => ({
        execute: async () => {
          applied.push("audit");
        },
      }),
    },
  } as unknown as Database;
  const processor = {
    execute: async () => {
      await started.promise;
      if (holdProcessing) await allowProcessing.promise;
      processed.resolve();
      if (outcome === "retry")
        throw Object.assign(new Error("connection interrupted"), {
          code: "ECONNRESET",
        });
      if (outcome === "dlq")
        throw Object.assign(new Error("denied"), {
          name: "AccessDeniedException",
        });
      return {
        transactionId: randomUUID(),
        status: "PROCESSED",
        idempotentReplay: false,
      };
    },
  } as unknown as ProcessWagerTransaction;
  const completion = new WagerConsumer(broker, processor, db)
    .tick()
    .then(() => {
      completed = true;
    });
  // Release all gates if a regression would otherwise hang the test runner.
  const watchdog = setTimeout(() => {
    started.resolve();
    release.resolve();
    processed.resolve();
    allowProcessing.resolve();
  }, 3000);
  return {
    started: started.promise,
    processed: processed.promise,
    release: release.resolve,
    finishProcessing: allowProcessing.resolve,
    aborted: () => aborted,
    applied,
    completion,
    completed: () => completed,
    maximumActive: () => maximumActive,
    renewals: () => renewals,
    close: async () => {
      clearTimeout(watchdog);
      started.resolve();
      release.resolve();
      allowProcessing.resolve();
      try {
        await completion;
      } finally {
        if (previous === undefined) delete process.env.QUEUE_VISIBILITY_SECONDS;
        else process.env.QUEUE_VISIBILITY_SECONDS = previous;
      }
    },
  };
}

for (const outcome of ["retry", "success", "dlq"] as const) {
  test(`pending visibility renewal finishes before ${outcome} completes`, async () => {
    const run = scenario(outcome);
    try {
      await run.processed;
      await Bun.sleep(400); // Includes the next timer tick while the renewal is blocked.
      expect(run.completed()).toBe(false);
      expect(run.renewals()).toBe(1);
      expect(run.maximumActive()).toBe(1);
      expect(run.applied).toEqual(outcome === "dlq" ? ["dlq", "audit"] : []);
      run.release();
      await run.completion;
      expect(run.applied).toEqual(
        outcome === "retry"
          ? ["heartbeat:1", "retry:8"]
          : outcome === "success"
            ? ["heartbeat:1", "ack"]
            : ["dlq", "audit", "heartbeat:1", "ack"],
      );
      const completed = [...run.applied];
      await Bun.sleep(400);
      expect(run.applied).toEqual(completed);
      expect(run.renewals()).toBe(1);
    } finally {
      await run.close();
    }
  });
}

test("a failed renewal is drained without preventing retry", async () => {
  const run = scenario("retry", "failed");
  try {
    await run.processed;
    run.release();
    await run.completion;
    expect(run.applied).toEqual(["retry:8"]);
    expect(run.maximumActive()).toBe(1);
  } finally {
    await run.close();
  }
});

test("a renewal transport timeout cannot hold finalization indefinitely", async () => {
  const run = scenario("retry", "timeout");
  try {
    await run.completion;
    expect(run.applied).toEqual(["retry:8"]);
    expect(run.renewals()).toBe(1);
    expect(run.aborted()).toBe(true);
  } finally {
    await run.close();
  }
});

test("heartbeat requests never overlap while financial processing continues", async () => {
  const run = scenario("retry", "held", true);
  try {
    await run.started;
    await Bun.sleep(400);
    expect(run.maximumActive()).toBe(1);
    expect(run.renewals()).toBe(1);
    run.finishProcessing();
    await run.processed;
    run.release();
    await run.completion;
    expect(run.applied).toEqual(["heartbeat:1", "retry:8"]);
  } finally {
    await run.close();
  }
});
