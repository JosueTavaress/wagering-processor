import { expect } from "bun:test";
import { randomUUID } from "node:crypto";
import { connect } from "../src/infra/database/Database";
import { compose, Application } from "../src/infra/composition";
import { ProcessWagerTransactionInput } from "../src/application/process-wager-transaction/ProcessWagerTransactionInput";
import { DeleteQueueCommand } from "@aws-sdk/client-sqs";
export async function waitFor(check: () => Promise<boolean>, timeout = 20000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await check()) return;
    await Bun.sleep(100);
  }
  throw new Error("CONDITION_TIMEOUT");
}
export async function setup() {
  const adminURL =
    process.env.DATABASE_URL ?? "postgresql://wager:wager@localhost:5432/wager";
  const admin = await connect();
  const name = "wager_test_" + randomUUID().replaceAll("-", "");
  await admin.em.fork().execute(`create database "${name}"`);
  const url = new URL(adminURL);
  url.pathname = "/" + name;
  process.env.DATABASE_URL = url.toString();
  process.env.QUEUE_PREFIX = name.slice(0, 30) + "-";
  for (const script of ["scripts/migrate.ts", "scripts/queues.ts"]) {
    const p = Bun.spawn([process.execPath, script], {
      env: process.env,
      stdout: "pipe",
      stderr: "pipe",
    });
    const code = await p.exited;
    if (code !== 0) throw new Error(await new Response(p.stderr).text());
  }
  const app = await compose();
  return {
    app,
    async close() {
      for (const queue of [
        "wager-transactions.fifo",
        "wager-transactions-dlq.fifo",
        "wager-events.fifo",
      ]) {
        try {
          await app.broker.client.send(
            new DeleteQueueCommand({ QueueUrl: await app.broker.url(queue) }),
          );
        } catch {}
      }
      app.broker.close();
      await app.db.close(true);
      await admin.em.fork().execute(`drop database "${name}" with (force)`);
      await admin.close(true);
      process.env.DATABASE_URL = adminURL;
      delete process.env.QUEUE_PREFIX;
    },
  };
}
export async function fixture(app: Application, balance = "100.00") {
  const playerId = randomUUID();
  const wallet = await app.open.execute({
    playerId,
    initialBalance: { amount: balance, currency: "BRL" },
  });
  return { wallet, command: command(wallet.id, playerId) };
}
export function command(
  walletId: string,
  playerId: string,
  kind: ProcessWagerTransactionInput["kind"] = "BET",
  amount = "10.00",
): ProcessWagerTransactionInput {
  const external = randomUUID();
  return {
    providerId: "provider-a",
    externalTransactionId: external,
    idempotencyKey: "provider-a:" + external,
    walletId,
    playerId,
    roundId: "round",
    gameId: "game",
    kind,
    money: { amount, currency: "BRL" },
  };
}
export async function consistent(app: Application, id: string) {
  expect((await app.reconcile.execute({ walletId: id })).consistent).toBe(true);
}
export async function spawnApi(port: number) {
  const p = Bun.spawn([process.execPath, "src/main.ts"], {
    env: { ...process.env, PORT: String(port) },
    stdout: "ignore",
    stderr: "pipe",
  });
  await waitFor(async () => {
    try {
      return (await fetch(`http://localhost:${port}/health/live`)).ok;
    } catch {
      return false;
    }
  });
  return p;
}
export function spawnWorker(role: string, extra: Record<string, string> = {}) {
  return Bun.spawn([process.execPath, "src/worker.ts"], {
    env: {
      ...process.env,
      WORKER_ROLE: role,
      METRICS_PORT: "0",
      NODE_ENV: "test",
      ...extra,
    },
    stdout: "ignore",
    stderr: "pipe",
  });
}
export async function submit(
  port: number,
  input: ProcessWagerTransactionInput,
) {
  const { idempotencyKey, ...body } = input;
  const response = await fetch(
    `http://localhost:${port}/wagering/transactions`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": idempotencyKey,
      },
      body: JSON.stringify(body),
    },
  );
  const result = (await response.json()) as {
    transactionId: string;
    status: string;
    balance: { amount: string; currency: string };
    idempotentReplay: boolean;
    failureCode?: string;
    code?: string;
  };
  return { response, result };
}
export async function send(
  app: Application,
  input: ProcessWagerTransactionInput,
  messageId = randomUUID(),
) {
  await app.broker.publish(
    JSON.stringify({
      messageId,
      type: "WagerTransactionRequested",
      occurredAt: new Date().toISOString(),
      data: input,
    }),
    input.walletId,
    randomUUID(),
    "wager-transactions.fifo",
  );
  return messageId;
}

export async function waitForWorkerCrash(
  worker: ReturnType<typeof spawnWorker>,
  timeout = 20000,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    // A signal termination may leave exitCode null. The exited promise also
    // settles when the child is killed, so it is the lifecycle source of truth.
    await Promise.race([
      worker.exited,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("WORKER_CRASH_TIMEOUT")),
          timeout,
        );
      }),
    ]);
    if (worker.signalCode !== "SIGKILL") {
      const stderr = await new Response(worker.stderr).text();
      throw new Error(
        `Worker exited without the injected SIGKILL (exitCode=${worker.exitCode}, signal=${worker.signalCode}): ${stderr}`,
      );
    }
  } catch (error) {
    // Never leave a worker from a failed scenario consuming subsequent tests.
    worker.kill("SIGKILL");
    await worker.exited;
    throw error;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export async function isolateOutboxMessage(
  app: Application,
  messageId: string,
) {
  const postponed = await app.db.em
    .fork()
    .execute<
      { id: string; next_attempt_at: Date }[]
    >("select id,next_attempt_at from outbox where published_at is null and id<>?", [messageId]);
  await app.db.em
    .fork()
    .execute(
      "update outbox set next_attempt_at=now()+interval '1 hour' where published_at is null and id<>?",
      [messageId],
    );
  return async () => {
    for (const row of postponed) {
      await app.db.em
        .fork()
        .execute(
          "update outbox set next_attempt_at=? where id=? and published_at is null",
          [row.next_attempt_at, row.id],
        );
    }
  };
}
