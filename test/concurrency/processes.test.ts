import { describe, beforeAll, afterAll, test, expect } from "bun:test";
import {
  setup,
  fixture,
  command,
  consistent,
  spawnApi,
  spawnWorker,
  submit,
  send,
  waitFor,
  waitForWorkerCrash,
} from "../helpers";
import { randomUUID } from "node:crypto";
import { Money } from "../../src/domain/entity/Money";
import {
  ReceiveMessageCommand,
  DeleteMessageCommand,
  GetQueueAttributesCommand,
} from "@aws-sdk/client-sqs";

let env: Awaited<ReturnType<typeof setup>>;
let apis: Awaited<ReturnType<typeof spawnApi>>[] = [];
beforeAll(async () => {
  env = await setup();
  apis = await Promise.all([43200, 43201, 43202].map(spawnApi));
});

afterAll(async () => {
  for (const p of apis) p.kill("SIGTERM");
  await Promise.all(apis.map((p) => p.exited));
  if (env) await env.close();
});

describe("Wallet locking and competing operations", () => {
  test("50 requests across three processes debit once", async () => {
    const { app } = env,
      { wallet, command: bet } = await fixture(app);
    const results = await Promise.all(
      Array.from({ length: 50 }, (_, i) => submit(43200 + (i % 3), bet)),
    );
    expect(results.every((r) => r.response.status === 200)).toBe(true);
    expect(results.filter((r) => !r.result.idempotentReplay)).toHaveLength(1);
    expect(new Set(results.map((r) => r.result.transactionId)).size).toBe(1);
    expect(
      (await app.getWallet.execute({ walletId: wallet.id })).balance.amount,
    ).toBe("90.00");
    expect(
      (
        await app.getLedger.execute({ walletId: wallet.id, limit: 100 })
      ).entries.filter((r) => r.direction === "DEBIT"),
    ).toHaveLength(1);
    await consistent(app, wallet.id);
  });

  test("two 80 BRL bets compete for 100 BRL", async () => {
    const { app } = env,
      { wallet } = await fixture(app);
    const results = await Promise.all([
      submit(43200, command(wallet.id, wallet.playerId, "BET", "80.00")),
      submit(43201, command(wallet.id, wallet.playerId, "BET", "80.00")),
    ]);
    expect(results.filter((r) => r.result.status === "PROCESSED")).toHaveLength(
      1,
    );
    expect(
      results.find((r) => r.result.status === "REJECTED")?.result.failureCode,
    ).toBe("INSUFFICIENT_FUNDS");
    expect(
      (await app.getWallet.execute({ walletId: wallet.id })).balance.amount,
    ).toBe("20.00");
    expect(
      (
        await app.getLedger.execute({ walletId: wallet.id, limit: 100 })
      ).entries.filter((r) => r.direction === "DEBIT"),
    ).toHaveLength(1);
    await consistent(app, wallet.id);
  });

  test("locked wallet does not block another wallet", async () => {
    const { app } = env,
      a = await fixture(app),
      b = await fixture(app);
    let release!: () => void;
    let locked!: () => void;
    const ready = new Promise<void>((r) => (locked = r));
    const gate = new Promise<void>((r) => (release = r));
    const holding = app.uow.run(async (db) => {
      await db.wallets.lock(a.wallet.id);
      locked();
      await gate;
    });
    await ready;
    try {
      const other = await Promise.race([
        submit(43202, b.command),
        Bun.sleep(2000).then(() => {
          throw new Error("OTHER_WALLET_BLOCKED");
        }),
      ]);
      expect(other.result.status).toBe("PROCESSED");
    } finally {
      release();
      await holding;
    }
    await consistent(app, a.wallet.id);
    await consistent(app, b.wallet.id);
  });

  test("concurrent reversals cannot reverse same reference/type twice", async () => {
    const { app } = env,
      { wallet, command: bet } = await fixture(app);
    await submit(43200, bet);
    const results = await Promise.all(
      [43200, 43201, 43202].map((port) =>
        submit(port, {
          ...command(wallet.id, wallet.playerId, "REFUND"),
          referenceExternalTransactionId: bet.externalTransactionId,
        }),
      ),
    );
    expect(results.filter((r) => r.result.status === "PROCESSED")).toHaveLength(
      1,
    );
    expect(
      results.filter((r) => r.result.failureCode === "ALREADY_REVERSED"),
    ).toHaveLength(2);
    await consistent(app, wallet.id);
  });
});

describe("Consumer and publisher crash recovery", () => {
  test("kill after commit before ack, redelivery and restart", async () => {
    const { app } = env,
      { wallet, command: bet } = await fixture(app);
    const messageId = randomUUID();
    const crashing = spawnWorker("consumer", {
      CRASH_AFTER_COMMIT_MESSAGE_ID: messageId,
      QUEUE_VISIBILITY_SECONDS: "2",
    });
    await send(app, bet, messageId);
    await waitForWorkerCrash(crashing);
    expect(
      (await app.getWallet.execute({ walletId: wallet.id })).balance.amount,
    ).toBe("90.00");
    const recovery = spawnWorker("consumer", { QUEUE_VISIBILITY_SECONDS: "2" });
    try {
      await waitFor(async () => {
        const stats = await app.broker.client.send(
          new GetQueueAttributesCommand({
            QueueUrl: await app.broker.url("wager-transactions.fifo"),
            AttributeNames: [
              "ApproximateNumberOfMessages",
              "ApproximateNumberOfMessagesNotVisible",
            ],
          }),
        );
        return (
          Number(stats.Attributes?.ApproximateNumberOfMessages) === 0 &&
          Number(stats.Attributes?.ApproximateNumberOfMessagesNotVisible) === 0
        );
      }, 30000);
    } finally {
      recovery.kill("SIGTERM");
      await recovery.exited;
    }
    expect(
      (
        await app.db.em
          .fork()
          .execute("select * from inbox where message_id=?", [messageId])
      ).length,
    ).toBe(1);
    expect(
      (
        await app.getLedger.execute({ walletId: wallet.id, limit: 50 })
      ).entries.filter((r) => r.direction === "DEBIT"),
    ).toHaveLength(1);
    await consistent(app, wallet.id);
    apis[0]!.kill("SIGTERM");
    await apis[0]!.exited;
    apis[0] = await spawnApi(43200);
    expect((await submit(43200, bet)).result.idempotentReplay).toBe(true);
    await consistent(app, wallet.id);
  });

  test("three consumers handle same-wallet queue commands", async () => {
    const { app } = env,
      { wallet } = await fixture(app);
    const workers = [
      spawnWorker("consumer"),
      spawnWorker("consumer"),
      spawnWorker("consumer"),
    ];
    try {
      const bets = Array.from({ length: 15 }, () =>
        command(wallet.id, wallet.playerId),
      );
      await Promise.all(bets.map((b) => send(app, b)));
      await waitFor(
        async () =>
          (
            await app.db.em
              .fork()
              .execute(
                "select id from wager_transactions where wallet_id=? and kind='BET'",
                [wallet.id],
              )
          ).length === 15,
        30000,
      );
      expect(
        (await app.getWallet.execute({ walletId: wallet.id })).balance.amount,
      ).toBe("0.00");
      await consistent(app, wallet.id);
    } finally {
      workers.forEach((p) => p.kill("SIGTERM"));
      await Promise.all(workers.map((p) => p.exited));
    }
  });

  test("publisher crash after send recovers lease; two processes drain outbox", async () => {
    const { app } = env,
      { wallet, command: bet } = await fixture(app);
    await submit(43201, bet);
    const expected = await app.db.em
      .fork()
      .execute<
        { id: string; payload: Record<string, unknown> }[]
      >("select id,payload from outbox where published_at is null");
    const crashed = spawnWorker("publisher", {
      CRASH_AFTER_PUBLISH: "1",
      OUTBOX_LEASE_SECONDS: "2",
    });
    await waitForWorkerCrash(crashed);
    const unpublished = await app.db.em
      .fork()
      .execute<
        { id: string }[]
      >("select id from outbox where published_at is null");
    expect(unpublished.length).toBeGreaterThan(0);
    const workers = [
      spawnWorker("publisher", { OUTBOX_LEASE_SECONDS: "2" }),
      spawnWorker("publisher", { OUTBOX_LEASE_SECONDS: "2" }),
    ];
    try {
      await waitFor(
        async () =>
          (
            await app.db.em
              .fork()
              .execute("select id from outbox where published_at is null")
          ).length === 0,
        60000,
      );
    } finally {
      workers.forEach((p) => p.kill("SIGTERM"));
      await Promise.all(workers.map((p) => p.exited));
    }
    const expectedById = new Map(
      expected.map((event) => [event.id, event.payload]),
    );
    const received = new Set<string>();
    const queueUrl = await app.broker.url("wager-events.fifo");
    await waitFor(async () => {
      const messages = await app.broker.client.send(
        new ReceiveMessageCommand({
          QueueUrl: queueUrl,
          MaxNumberOfMessages: 10,
          WaitTimeSeconds: 1,
        }),
      );
      for (const message of messages.Messages ?? []) {
        const event = JSON.parse(message.Body!) as Record<string, unknown>;
        const eventId = event.eventId;
        if (typeof eventId !== "string") {
          throw new Error("Received event without a string eventId");
        }
        const original = expectedById.get(eventId);
        if (!original) {
          throw new Error(`Received unexpected event: ${eventId}`);
        }
        // A duplicate must retain the original event id and complete envelope.
        expect(event).toEqual(original);
        received.add(eventId);
        await app.broker.client.send(
          new DeleteMessageCommand({
            QueueUrl: queueUrl,
            ReceiptHandle: message.ReceiptHandle!,
          }),
        );
      }
      return received.size === expectedById.size;
    }, 30000);
    expect([...received].sort()).toEqual([...expectedById.keys()].sort());
    await consistent(app, wallet.id);
  });
});

// Every request goes through one of three independent API processes.
function concurrentSubmissions(inputs: Parameters<typeof submit>[1][]) {
  return Promise.all(inputs.map((input, i) => submit(43200 + (i % 3), input)));
}

async function assertFinancialState(
  walletId: string,
  balance: string,
  version: number,
) {
  const { app } = env;
  const wallet = await app.getWallet.execute({ walletId });
  expect(wallet.balance.amount).toBe(balance);
  expect(wallet.version).toBe(version);
  const reconciliation = await app.reconcile.execute({ walletId });
  expect(reconciliation.consistent).toBe(true);
  expect(reconciliation.difference.amount).toBe("0.00");
  const entries = await app.db.em.fork().execute<
    {
      transaction_id: string;
      direction: string;
      balance_before: string;
      balance_after: string;
      amount: string;
      currency: string;
    }[]
  >("select * from wallet_ledger where wallet_id=? order by sequence", [walletId]);
  expect(new Set(entries.map((entry) => entry.transaction_id)).size).toBe(
    entries.length,
  );
  let previous = Money.zero(wallet.balance.currency);
  for (const entry of entries) {
    const before = Money.from({
      amount: entry.balance_before,
      currency: entry.currency,
    });
    const after = Money.from({
      amount: entry.balance_after,
      currency: entry.currency,
    });
    const amount = Money.from({
      amount: entry.amount,
      currency: entry.currency,
    });
    expect(before.equals(previous)).toBe(true);
    expect(after.isNegative()).toBe(false);
    expect(
      (entry.direction === "CREDIT"
        ? before.add(amount)
        : before.subtract(amount)
      ).equals(after),
    ).toBe(true);
    previous = after;
  }
  expect(previous.toString()).toBe(balance);
  const invalid = await app.db.em.fork().execute(
    `select t.id from wager_transactions t left join wallet_ledger l on l.transaction_id=t.id
     where t.wallet_id=? group by t.id
     having count(l.id)<>case when t.status='PROCESSED' and t.kind<>'LOSS' then 1 else 0 end`,
    [walletId],
  );
  expect(invalid).toHaveLength(0);
  const statuses = await app.db.em
    .fork()
    .execute<
      { status: string; count: string }[]
    >("select status,count(*)::text count from wager_transactions where wallet_id=? group by status", [walletId]);
  const events = await app.db.em
    .fork()
    .execute<
      { event_type: string; count: string }[]
    >("select event_type,count(*)::text count from outbox where aggregate_id=? group by event_type", [walletId]);
  const countStatus = (status: string) =>
    statuses.find((row) => row.status === status)?.count ?? "0";
  const countEvent = (type: string) =>
    events.find((row) => row.event_type === type)?.count ?? "0";
  expect(countEvent("WagerTransactionProcessed")).toBe(
    countStatus("PROCESSED"),
  );
  expect(countEvent("WagerTransactionRejected")).toBe(countStatus("REJECTED"));
  expect(countEvent("WalletBalanceChanged")).toBe(String(entries.length));
}

describe("Concurrent replays and balance updates", () => {
  for (const kind of ["WIN", "LOSS", "REFUND", "ROLLBACK"] as const) {
    test(`50 concurrent replays of ${kind} produce one financial outcome`, async () => {
      const { app } = env;
      const { wallet } = await fixture(app);
      const input = command(
        wallet.id,
        wallet.playerId,
        kind,
        kind === "LOSS" ? "0.00" : "10.00",
      );
      if (kind === "REFUND" || kind === "ROLLBACK") {
        const reference = command(
          wallet.id,
          wallet.playerId,
          kind === "REFUND" ? "BET" : "WIN",
        );
        expect((await submit(43200, reference)).response.status).toBe(200);
        input.referenceExternalTransactionId = reference.externalTransactionId;
      }
      const results = await concurrentSubmissions(
        Array.from({ length: 50 }, () => input),
      );
      expect(
        results.every(
          ({ response, result }) =>
            response.status === 200 && result.status === "PROCESSED",
        ),
      ).toBe(true);
      expect(
        results.filter(({ result }) => !result.idempotentReplay),
      ).toHaveLength(1);
      expect(
        new Set(results.map(({ result }) => result.transactionId)).size,
      ).toBe(1);
      const entries = await app.db.em
        .fork()
        .execute("select id from wallet_ledger where transaction_id=?", [
          results[0]!.result.transactionId,
        ]);
      expect(entries).toHaveLength(kind === "LOSS" ? 0 : 1);
      await assertFinancialState(
        wallet.id,
        kind === "WIN" ? "110.00" : "100.00",
        kind === "LOSS" ? 1 : kind === "WIN" ? 2 : 3,
      );
    });
  }

  test("30 distinct bets exhaust a hot wallet without negative balance", async () => {
    const { app } = env;
    const { wallet } = await fixture(app);
    const inputs = Array.from({ length: 30 }, () =>
      command(wallet.id, wallet.playerId),
    );
    const results = await concurrentSubmissions(inputs);
    expect(
      results.filter(({ result }) => result.status === "PROCESSED"),
    ).toHaveLength(10);
    expect(
      results.filter(
        ({ response, result }) =>
          response.status === 422 &&
          result.failureCode === "INSUFFICIENT_FUNDS",
      ),
    ).toHaveLength(20);
    const replays = await concurrentSubmissions(inputs);
    replays.forEach(({ result }, i) =>
      expect(result).toEqual({ ...results[i]!.result, idempotentReplay: true }),
    );
    await assertFinancialState(wallet.id, "0.00", 11);
  });

  test("mixed concurrent credits and debits retain every update", async () => {
    const { app } = env;
    const { wallet } = await fixture(app, "200.00");
    const inputs = Array.from({ length: 30 }, (_, i) =>
      command(wallet.id, wallet.playerId, i % 2 ? "WIN" : "BET"),
    );
    const results = await concurrentSubmissions(inputs);
    expect(results.every(({ response }) => response.status === 200)).toBe(true);
    await assertFinancialState(wallet.id, "200.00", 31);
  });
});

describe("Identity conflicts and wallet isolation", () => {
  test("divergent payloads racing on one key choose exactly one payload", async () => {
    const { app } = env;
    const { wallet, command: bet } = await fixture(app);
    const results = await concurrentSubmissions(
      Array.from({ length: 24 }, (_, i) => ({
        ...bet,
        money: { amount: i % 2 ? "10.00" : "20.00", currency: "BRL" },
      })),
    );
    const accepted = results.filter(({ response }) => response.status === 200);
    expect(accepted).toHaveLength(12);
    expect(
      accepted.filter(({ result }) => !result.idempotentReplay),
    ).toHaveLength(1);
    expect(
      results.filter(
        ({ response, result }) =>
          response.status === 409 && result.code === "IDEMPOTENCY_CONFLICT",
      ),
    ).toHaveLength(12);
    const original = await app.getTransaction.execute({
      transactionId: accepted[0]!.result.transactionId,
    });
    await assertFinancialState(
      wallet.id,
      original.money.amount === "10.00" ? "90.00" : "80.00",
      2,
    );
  });

  test("different keys racing on the same provider identity cannot double debit", async () => {
    const { app } = env;
    const { wallet, command: bet } = await fixture(app);
    const results = await concurrentSubmissions(
      Array.from({ length: 18 }, () => ({
        ...bet,
        idempotencyKey: randomUUID(),
      })),
    );
    expect(
      results.filter(({ response }) => response.status === 200),
    ).toHaveLength(1);
    expect(
      results.filter(
        ({ response, result }) =>
          response.status === 409 && result.code === "IDEMPOTENCY_CONFLICT",
      ),
    ).toHaveLength(17);
    await assertFinancialState(wallet.id, "90.00", 2);
  });

  test("providers can concurrently use the same external id independently", async () => {
    const { app } = env;
    const { wallet, command: bet } = await fixture(app);
    const results = await concurrentSubmissions(
      ["provider-a", "provider-b", "provider-c"].map((providerId) => ({
        ...bet,
        providerId,
        idempotencyKey: `${providerId}:${bet.externalTransactionId}`,
      })),
    );
    expect(results.every(({ response }) => response.status === 200)).toBe(true);
    expect(
      new Set(results.map(({ result }) => result.transactionId)).size,
    ).toBe(3);
    await assertFinancialState(wallet.id, "70.00", 4);
  });

  test("eight wallets retain independent balances under simultaneous traffic", async () => {
    const { app } = env;
    const fixtures = await Promise.all(
      Array.from({ length: 8 }, () => fixture(app)),
    );
    const results = await concurrentSubmissions(
      fixtures.flatMap(({ wallet }) =>
        Array.from({ length: 6 }, () => command(wallet.id, wallet.playerId)),
      ),
    );
    expect(results.every(({ response }) => response.status === 200)).toBe(true);
    for (const { wallet } of fixtures)
      await assertFinancialState(wallet.id, "40.00", 7);
  });

  test("terminal rejection remains unchanged during concurrent replays after funding", async () => {
    const { app } = env;
    const { wallet } = await fixture(app);
    const bet = command(wallet.id, wallet.playerId, "BET", "200.00");
    const original = await submit(43200, bet);
    expect(original.response.status).toBe(422);
    expect(
      (
        await submit(
          43201,
          command(wallet.id, wallet.playerId, "WIN", "200.00"),
        )
      ).response.status,
    ).toBe(200);
    const replays = await concurrentSubmissions(
      Array.from({ length: 30 }, () => bet),
    );
    for (const replay of replays) {
      expect(replay.response.status).toBe(422);
      expect(replay.result).toEqual({
        ...original.result,
        idempotentReplay: true,
      });
    }
    await assertFinancialState(wallet.id, "300.00", 2);
  });
});

describe("Competing transports and reference workers", () => {
  test("HTTP and three SQS consumers racing on one operation debit once", async () => {
    const { app } = env;
    const { wallet, command: bet } = await fixture(app);
    const workers = Array.from({ length: 3 }, () => spawnWorker("consumer"));
    try {
      const [http] = await Promise.all([
        concurrentSubmissions(Array.from({ length: 15 }, () => bet)),
        Promise.all(Array.from({ length: 15 }, () => send(app, bet))),
      ]);
      expect(http.every(({ response }) => response.status === 200)).toBe(true);
      await waitFor(async () => {
        const rows = await app.db.em
          .fork()
          .execute<
            { count: string }[]
          >("select count(*)::text count from inbox where transaction_id=?", [http[0]!.result.transactionId]);
        return rows[0]?.count === "15";
      }, 30000);
      await assertFinancialState(wallet.id, "90.00", 2);
    } finally {
      workers.forEach((worker) => worker.kill("SIGTERM"));
      await Promise.all(workers.map((worker) => worker.exited));
    }
  });

  test("two reference workers resolve out-of-order competing reversals once per kind", async () => {
    const { app } = env;
    const { wallet, command: bet } = await fixture(app);
    const reversals = Array.from({ length: 6 }, (_, i) => ({
      ...command(wallet.id, wallet.playerId, i % 2 ? "REFUND" : "ROLLBACK"),
      referenceExternalTransactionId: bet.externalTransactionId,
    }));
    const pending = await concurrentSubmissions(reversals);
    expect(
      pending.every(
        ({ response, result }) =>
          response.status === 202 && result.status === "PENDING_REFERENCE",
      ),
    ).toBe(true);
    expect((await submit(43200, bet)).response.status).toBe(200);
    const workers = [spawnWorker("reference"), spawnWorker("reference")];
    try {
      await waitFor(async () => {
        const rows = await app.db.em
          .fork()
          .execute(
            "select id from wager_transactions where wallet_id=? and status='PENDING_REFERENCE'",
            [wallet.id],
          );
        return rows.length === 0;
      }, 30000);
      const results = await concurrentSubmissions(reversals);
      for (const kind of ["REFUND", "ROLLBACK"]) {
        const group = results.filter((_, i) => reversals[i]!.kind === kind);
        expect(
          group.filter(({ result }) => result.status === "PROCESSED"),
        ).toHaveLength(1);
        expect(
          group.filter(
            ({ result }) => result.failureCode === "ALREADY_REVERSED",
          ),
        ).toHaveLength(2);
        expect(group.every(({ result }) => result.idempotentReplay)).toBe(true);
      }
      // The contract permits one REFUND and one ROLLBACK of the same BET.
      await assertFinancialState(wallet.id, "110.00", 4);
    } finally {
      workers.forEach((worker) => worker.kill("SIGTERM"));
      await Promise.all(workers.map((worker) => worker.exited));
    }
  });

  test("a bet racing a debit rollback never spends the same funds twice", async () => {
    const { app } = env;
    const { wallet } = await fixture(app, "0.00");
    const win = command(wallet.id, wallet.playerId, "WIN", "100.00");
    expect((await submit(43200, win)).response.status).toBe(200);
    const inputs = [
      command(wallet.id, wallet.playerId, "BET", "80.00"),
      {
        ...command(wallet.id, wallet.playerId, "ROLLBACK", "100.00"),
        referenceExternalTransactionId: win.externalTransactionId,
      },
    ];
    const results = await concurrentSubmissions(inputs);
    expect(
      results.filter(({ response }) => response.status === 200),
    ).toHaveLength(1);
    expect(
      results.filter(({ response }) => response.status === 422),
    ).toHaveLength(1);
    const betWon = results[0]!.result.status === "PROCESSED";
    expect(results[betWon ? 1 : 0]!.result.failureCode).toBe(
      betWon ? "REVERSAL_INSUFFICIENT_FUNDS" : "INSUFFICIENT_FUNDS",
    );
    const replays = await concurrentSubmissions(inputs);
    replays.forEach(({ result }, i) =>
      expect(result).toEqual({ ...results[i]!.result, idempotentReplay: true }),
    );
    await assertFinancialState(wallet.id, betWon ? "20.00" : "0.00", 3);
  });
});

describe("Wallet creation and global idempotency", () => {
  test("concurrent wallet openings create exactly one opening credit", async () => {
    const playerId = randomUUID();
    const results = await Promise.all(
      Array.from({ length: 12 }, async (_, i) => {
        const response = await fetch(
          `http://localhost:${43200 + (i % 3)}/wallets`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              playerId,
              initialBalance: { amount: "100.00", currency: "BRL" },
            }),
          },
        );
        return {
          status: response.status,
          body: (await response.json()) as { id?: string; code?: string },
        };
      }),
    );
    expect(results.filter(({ status }) => status === 201)).toHaveLength(1);
    expect(
      results.filter(
        ({ status, body }) =>
          status === 409 && body.code === "UNIQUENESS_CONFLICT",
      ),
    ).toHaveLength(11);
    const walletId = results.find(({ status }) => status === 201)!.body.id!;
    const rows = await env.app.db.em
      .fork()
      .execute(
        "select id from wager_transactions where wallet_id=? and kind='OPENING'",
        [walletId],
      );
    expect(rows).toHaveLength(1);
    await assertFinancialState(walletId, "100.00", 1);
  });

  test("one global idempotency key racing across two wallets commits to only one", async () => {
    const { app } = env;
    const a = await fixture(app);
    const b = await fixture(app);
    const key = randomUUID();
    const inputs = [a.command, b.command].map((input) => ({
      ...input,
      idempotencyKey: key,
    }));
    const results = await concurrentSubmissions(
      Array.from({ length: 18 }, (_, i) => inputs[i % 2]!),
    );
    expect(
      results.filter(({ response }) => response.status === 200),
    ).toHaveLength(9);
    expect(
      results.filter(({ response }) => response.status === 409),
    ).toHaveLength(9);
    expect(
      results.filter(
        ({ response, result }) =>
          response.status === 200 && !result.idempotentReplay,
      ),
    ).toHaveLength(1);
    const rows = await app.db.em
      .fork()
      .execute<
        { wallet_id: string }[]
      >("select wallet_id from wager_transactions where idempotency_key=?", [key]);
    expect(rows).toHaveLength(1);
    for (const { wallet } of [a, b]) {
      const won = wallet.id === rows[0]!.wallet_id;
      await assertFinancialState(
        wallet.id,
        won ? "90.00" : "100.00",
        won ? 2 : 1,
      );
    }
  });
});

describe("Graceful shutdown", () => {
  test("SIGTERM drains a consumer blocked on an in-flight wallet transaction", async () => {
    const { app } = env;
    const { wallet, command: bet } = await fixture(app);
    let release!: () => void;
    let locked!: (pid: number) => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const acquired = new Promise<number>((resolve) => {
      locked = resolve;
    });
    const holding = app.db.em.fork().transactional(async (entityManager) => {
      const rows = await entityManager.execute<{ pid: number }[]>(
        "select pg_backend_pid() as pid",
      );
      await entityManager.execute(
        "select id from wallets where id=? for update",
        [wallet.id],
      );
      locked(rows[0]!.pid);
      await gate;
    });
    const blocker = await acquired;
    const worker = spawnWorker("consumer", {
      METRICS_PORT: "43390",
      QUEUE_VISIBILITY_SECONDS: "2",
    });
    let exited = false;
    void worker.exited.then(() => {
      exited = true;
    });
    try {
      await waitFor(async () => {
        try {
          return (
            (await fetch("http://localhost:43390/health/ready")).status === 200
          );
        } catch {
          return false;
        }
      });
      const messageId = await send(app, bet);
      await waitFor(async () => {
        const waiting = await app.db.em
          .fork()
          .execute(
            "select pid from pg_stat_activity where datname=current_database() and ?::integer=any(pg_blocking_pids(pid))",
            [blocker],
          );
        return waiting.length > 0;
      });
      worker.kill("SIGTERM");
      await waitFor(
        async () =>
          (await fetch("http://localhost:43390/health/ready")).status === 503,
      );
      expect(exited).toBe(false);
      release();
      await holding;
      await waitFor(async () => exited, 15000);
      expect(await worker.exited).toBe(0);
      const inbox = await app.db.em
        .fork()
        .execute("select * from inbox where message_id=?", [messageId]);
      expect(inbox).toHaveLength(1);
      await waitFor(async () => {
        const stats = await app.broker.client.send(
          new GetQueueAttributesCommand({
            QueueUrl: await app.broker.url("wager-transactions.fifo"),
            AttributeNames: [
              "ApproximateNumberOfMessages",
              "ApproximateNumberOfMessagesNotVisible",
            ],
          }),
        );
        return (
          Number(stats.Attributes?.ApproximateNumberOfMessages) === 0 &&
          Number(stats.Attributes?.ApproximateNumberOfMessagesNotVisible) === 0
        );
      });
      await assertFinancialState(wallet.id, "90.00", 2);
    } finally {
      release();
      await holding;
      if (!exited) worker.kill("SIGKILL");
      await worker.exited;
    }
  });
});
