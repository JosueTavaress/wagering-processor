import { beforeAll, afterAll, test, expect } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  setup,
  fixture,
  command,
  consistent,
  send,
  waitFor,
  isolateOutboxMessage,
  spawnApi,
  submit,
} from "../helpers";
import { ProcessWagerTransaction } from "../../src/application/process-wager-transaction/ProcessWagerTransaction";
import { ReferenceWorker } from "../../src/infra/workers/ReferenceWorker";
import { WagerConsumer } from "../../src/infra/workers/WagerConsumer";
import { SqsBroker } from "../../src/infra/messaging/SqsBroker";
import { OutboxPublisher } from "../../src/infra/workers/OutboxPublisher";
import {
  ReceiveMessageCommand,
  CreateQueueCommand,
  DeleteQueueCommand,
  DeleteMessageCommand,
  GetQueueAttributesCommand,
} from "@aws-sdk/client-sqs";
let env: Awaited<ReturnType<typeof setup>>;
beforeAll(async () => {
  env = await setup();
});
afterAll(async () => {
  if (env) await env.close();
});

test("opening, duplicate wallet and immutable schema constraints", async () => {
  const { app } = env;
  const { wallet, command: bet } = await fixture(app);
  expect(wallet.version).toBe(1);
  expect(
    (await app.getLedger.execute({ walletId: wallet.id, limit: 50 })).entries,
  ).toHaveLength(1);
  await expect(
    app.open.execute({
      playerId: wallet.playerId,
      initialBalance: { amount: "1.00", currency: "BRL" },
    }),
  ).rejects.toThrow("UNIQUENESS_CONFLICT");
  for (const sql of [
    "update wallet_ledger set amount=amount where wallet_id=?",
    "delete from wallet_ledger where wallet_id=?",
    "update wallets set balance=-1,version=version+1 where id=?",
    "update wallets set balance=101,version=version+1 where id=?",
    "update wallets set balance=100.001,version=version+1 where id=?",
    "update wallets set version=version+1 where id=?",
  ])
    await expect(app.db.em.fork().execute(sql, [wallet.id])).rejects.toThrow();
  await app.process.execute(bet);
  await consistent(app, wallet.id);
});

test("replay preserves original balance and divergent identity conflicts", async () => {
  const { app } = env,
    { wallet, command: bet } = await fixture(app);
  const original = await app.process.execute(bet);
  await app.process.execute(
    command(wallet.id, wallet.playerId, "WIN", "40.00"),
  );
  const replay = await app.process.execute(bet);
  expect(replay.balance).toEqual(original.balance);
  expect(replay.idempotentReplay).toBe(true);
  await expect(
    app.process.execute({
      ...bet,
      money: { amount: "11.00", currency: "BRL" },
    }),
  ).rejects.toThrow("IDEMPOTENCY_CONFLICT");
  await expect(
    app.process.execute({ ...bet, idempotencyKey: "different" }),
  ).rejects.toThrow("IDEMPOTENCY_CONFLICT");
  expect(
    (await app.getWallet.execute({ walletId: wallet.id })).balance.amount,
  ).toBe("130.00");
  await consistent(app, wallet.id);
});

test("loss, refund, duplicate reversal and rollback", async () => {
  const { app } = env,
    { wallet, command: bet } = await fixture(app);
  const b = await app.process.execute(bet);
  const refund = {
    ...command(wallet.id, wallet.playerId, "REFUND"),
    referenceExternalTransactionId: bet.externalTransactionId,
  };
  expect((await app.process.execute(refund)).status).toBe("PROCESSED");
  const duplicate = await app.process.execute({
    ...refund,
    externalTransactionId: randomUUID(),
    idempotencyKey: randomUUID(),
  });
  expect(duplicate.status).toBe("REJECTED");
  if (duplicate.status === "REJECTED")
    expect(duplicate.failureCode).toBe("ALREADY_REVERSED");
  const loss = await app.process.execute(
    command(wallet.id, wallet.playerId, "LOSS", "0.00"),
  );
  expect(loss.status).toBe("PROCESSED");
  expect(
    (
      await app.db.em
        .fork()
        .execute("select * from wallet_ledger where transaction_id=?", [
          loss.transactionId,
        ])
    ).length,
  ).toBe(0);
  const rollback = await app.process.execute({
    ...command(wallet.id, wallet.playerId, "ROLLBACK"),
    referenceExternalTransactionId: refund.externalTransactionId,
  });
  expect(rollback.status).toBe("PROCESSED");
  expect(rollback.balance?.amount).toBe("90.00");
  await expect(
    app.db.em
      .fork()
      .execute("update wager_transactions set status='PENDING' where id=?", [
        b.transactionId,
      ]),
  ).rejects.toThrow();
  await consistent(app, wallet.id);
});

test("spent win rollback, reference mismatch and currency mismatch reject", async () => {
  const { app } = env,
    { wallet } = await fixture(app, "0.00");
  const win = command(wallet.id, wallet.playerId, "WIN", "10.00");
  await app.process.execute(win);
  await app.process.execute(command(wallet.id, wallet.playerId));
  const r = await app.process.execute({
    ...command(wallet.id, wallet.playerId, "ROLLBACK"),
    referenceExternalTransactionId: win.externalTransactionId,
  });
  expect(r.status).toBe("REJECTED");
  if (r.status === "REJECTED")
    expect(r.failureCode).toBe("REVERSAL_INSUFFICIENT_FUNDS");
  const invalid = await app.process.execute({
    ...command(wallet.id, wallet.playerId, "ROLLBACK"),
    roundId: "other",
    referenceExternalTransactionId: win.externalTransactionId,
  });
  expect(invalid.status).toBe("REJECTED");
  const currency = await app.process.execute({
    ...command(wallet.id, wallet.playerId),
    money: { amount: "10.00", currency: "USD" },
  });
  expect(currency.status).toBe("REJECTED");
  await consistent(app, wallet.id);
});

test("outbox fault rolls back wallet, transaction, ledger and inbox", async () => {
  const { app } = env,
    { wallet, command: bet } = await fixture(app);
  const processor = new ProcessWagerTransaction({
    run: (work) =>
      app.uow.run((db) =>
        work({
          ...db,
          outbox: {
            enqueue: async () => {
              throw new Error("INJECTED_OUTBOX_FAILURE");
            },
          },
        }),
      ),
  });
  const messageId = randomUUID();
  await expect(
    processor.execute(bet, {
      correlationId: messageId,
      inbox: { messageId, consumerName: "test", payloadHash: "hash" },
    }),
  ).rejects.toThrow("INJECTED_OUTBOX_FAILURE");
  expect(
    (await app.getWallet.execute({ walletId: wallet.id })).balance.amount,
  ).toBe("100.00");
  expect(
    (await app.getLedger.execute({ walletId: wallet.id, limit: 50 })).entries,
  ).toHaveLength(1);
  expect(
    (
      await app.db.em
        .fork()
        .execute("select * from inbox where message_id=?", [messageId])
    ).length,
  ).toBe(0);
  expect(
    (
      await app.db.em
        .fork()
        .execute("select * from wager_transactions where idempotency_key=?", [
          bet.idempotencyKey,
        ])
    ).length,
  ).toBe(0);
  await consistent(app, wallet.id);
});

test("refund/rollback before reference recover and orphan expires", async () => {
  const { app } = env;
  for (const kind of ["REFUND", "ROLLBACK"] as const) {
    const { wallet, command: bet } = await fixture(app);
    const reversal = {
      ...command(wallet.id, wallet.playerId, kind),
      referenceExternalTransactionId: bet.externalTransactionId,
    };
    const pending = await app.process.execute(reversal);
    expect(pending.status).toBe("PENDING_REFERENCE");
    await app.process.execute(bet);
    await app.db.em
      .fork()
      .execute(
        "update wager_transactions set next_attempt_at=now() where id=?",
        [pending.transactionId],
      );
    await new ReferenceWorker(app.db, app.process).tick();
    expect(
      (
        await app.getTransaction.execute({
          transactionId: pending.transactionId,
        })
      ).status,
    ).toBe("PROCESSED");
    expect(
      (await app.getWallet.execute({ walletId: wallet.id })).balance.amount,
    ).toBe("100.00");
    await consistent(app, wallet.id);
  }
  const { wallet } = await fixture(app);
  const orphan = await app.process.execute({
    ...command(wallet.id, wallet.playerId, "REFUND"),
    referenceExternalTransactionId: "missing",
  });
  await app.db.em
    .fork()
    .execute(
      "update wager_transactions set attempts=10,next_attempt_at=now() where id=?",
      [orphan.transactionId],
    );
  await new ReferenceWorker(app.db, app.process).tick();
  expect(
    (await app.getTransaction.execute({ transactionId: orphan.transactionId }))
      .failureCode,
  ).toBe("REFERENCE_EXPIRED");
  await consistent(app, wallet.id);
});

test("SQS inbox redelivery and message-id conflict", async () => {
  const { app } = env,
    { wallet, command: bet } = await fixture(app);
  const consumer = new WagerConsumer(app.broker, app.process, app.db);
  const messageId = await send(app, bet);
  await consumer.tick();
  await send(app, bet, messageId);
  await consumer.tick();
  expect(
    (await app.getWallet.execute({ walletId: wallet.id })).balance.amount,
  ).toBe("90.00");
  expect(
    (
      await app.db.em
        .fork()
        .execute("select * from inbox where message_id=?", [messageId])
    ).length,
  ).toBe(1);
  await send(app, command(wallet.id, wallet.playerId), messageId);
  await consumer.tick();
  expect(
    (await app.getWallet.execute({ walletId: wallet.id })).balance.amount,
  ).toBe("90.00");
  await consistent(app, wallet.id);
});
// Inject a recognizable connection failure inside PostgreSQL, without replacing the use case.
async function interruptTransactionInDatabase() {
  const em = env.app.db.em.fork();
  await em.execute(`create function test_connection_failure() returns trigger language plpgsql as $$
    begin raise exception 'injected connection failure' using errcode='08006'; end $$`);
  try {
    await em.execute(
      "create trigger test_connection_failure before insert on wager_transactions for each row execute function test_connection_failure()",
    );
  } catch (error) {
    await em.execute("drop function test_connection_failure()");
    throw error;
  }
  return async () => {
    await em.execute(
      "drop trigger test_connection_failure on wager_transactions",
    );
    await em.execute("drop function test_connection_failure()");
  };
}

test("transient database failure retries and then succeeds", async () => {
  const { app } = env,
    { wallet, command: bet } = await fixture(app);
  const messageId = await send(app, bet);
  const consumer = new WagerConsumer(app.broker, app.process, app.db);
  const restoreDatabase = await interruptTransactionInDatabase();
  try {
    expect(await consumer.tick()).toBe(1);
  } finally {
    await restoreDatabase();
  }
  expect(
    (await app.getWallet.execute({ walletId: wallet.id })).balance.amount,
  ).toBe("100.00");
  const inbox = await app.db.em
    .fork()
    .execute<
      { count: string }[]
    >("select count(*)::text count from inbox where message_id=?", [messageId]);
  expect(inbox[0]!.count).toBe("0");
  const transactionsBeforeRetry = await app.db.em
    .fork()
    .execute(
      "select id from wager_transactions where provider_id=? and external_transaction_id=?",
      [bet.providerId, bet.externalTransactionId],
    );
  expect(transactionsBeforeRetry).toHaveLength(0);

  // A poll can be empty even after visibility expires. Observe committed recovery.
  await waitFor(async () => {
    await consumer.tick();
    const current = await app.getWallet.execute({ walletId: wallet.id });
    return current.balance.amount === "90.00";
  });
  expect(
    (await app.getWallet.execute({ walletId: wallet.id })).balance.amount,
  ).toBe("90.00");
  const entries = await app.db.em.fork().execute<
    {
      status: string;
      direction: string;
      amount: string;
    }[]
  >(
    `select t.status,l.direction,l.amount::text amount
     from wager_transactions t join wallet_ledger l on l.transaction_id=t.id
     where t.provider_id=? and t.external_transaction_id=?`,
    [bet.providerId, bet.externalTransactionId],
  );
  expect(entries).toEqual([
    { status: "PROCESSED", direction: "DEBIT", amount: "10.00" },
  ]);
  const completedInbox = await app.db.em
    .fork()
    .execute<
      { processed_at: Date | null }[]
    >("select processed_at from inbox where message_id=?", [messageId]);
  expect(completedInbox).toHaveLength(1);
  expect(completedInbox[0]!.processed_at).not.toBeNull();
  const events = await app.db.em.fork().execute<{ event_type: string }[]>(
    `select o.event_type from outbox o join wager_transactions t
     on o.payload->'data'->>'transactionId'=t.id::text
     where t.provider_id=? and t.external_transaction_id=? order by o.event_type`,
    [bet.providerId, bet.externalTransactionId],
  );
  expect(events.map((event) => event.event_type)).toEqual([
    "WagerTransactionProcessed",
    "WalletBalanceChanged",
  ]);
  await consistent(app, wallet.id);
});

test("poison message and infrastructure exhaustion reach DLQ", async () => {
  const { app } = env;
  const consumer = new WagerConsumer(app.broker, app.process, app.db);
  await app.broker.publish(
    "{invalid",
    "poison",
    randomUUID(),
    "wager-transactions.fifo",
  );
  await consumer.tick();
  const { command: bet } = await fixture(app);
  await send(app, bet);
  const previousMaxReceiveCount = process.env.MAX_RECEIVE_COUNT;
  const restoreDatabase = await interruptTransactionInDatabase();
  process.env.MAX_RECEIVE_COUNT = "1";
  try {
    await new WagerConsumer(app.broker, app.process, app.db).tick();
  } finally {
    await restoreDatabase();
    if (previousMaxReceiveCount === undefined)
      delete process.env.MAX_RECEIVE_COUNT;
    else process.env.MAX_RECEIVE_COUNT = previousMaxReceiveCount;
  }
  const audit = await app.db.em
    .fork()
    .execute<{ reason: string }[]>("select reason from failed_messages");
  expect(audit.some((r) => r.reason === "INVALID_MESSAGE")).toBe(true);
  expect(
    audit.some((r) => r.reason === "INFRASTRUCTURE_RETRIES_EXHAUSTED"),
  ).toBe(true);
  const dlq = await app.broker.client.send(
    new GetQueueAttributesCommand({
      QueueUrl: await app.broker.url("wager-transactions-dlq.fifo"),
      AttributeNames: ["ApproximateNumberOfMessages"],
    }),
  );
  expect(
    Number(dlq.Attributes?.ApproximateNumberOfMessages),
  ).toBeGreaterThanOrEqual(2);
});

test("concurrent publishers drain durable outbox", async () => {
  const { app } = env;
  const { wallet, command: bet } = await fixture(app);
  await app.process.execute(bet);
  const a = new OutboxPublisher(app.db, app.broker),
    b = new OutboxPublisher(app.db, app.broker);
  await waitFor(async () => {
    await Promise.all([a.tick(), b.tick()]);
    return (
      (
        await app.db.em
          .fork()
          .execute("select id from outbox where published_at is null")
      ).length === 0
    );
  }, 30000);
  expect(
    (
      await app.db.em
        .fork()
        .execute(
          "select id from outbox where aggregate_id=? and published_at is not null",
          [wallet.id],
        )
    ).length,
  ).toBe(4);
  const events = await app.broker.client.send(
    new ReceiveMessageCommand({
      QueueUrl: await app.broker.url("wager-events.fifo"),
      MaxNumberOfMessages: 10,
      WaitTimeSeconds: 1,
    }),
  );
  expect(events.Messages?.length).toBeGreaterThan(0);
  for (const m of events.Messages ?? []) {
    const e = JSON.parse(m.Body!);
    expect(e.version).toBe(1);
    expect(typeof e.eventId).toBe("string");
  }
  await consistent(app, wallet.id);
});

test("HTTP status mapping, health, lookup, pagination and metrics", async () => {
  const { app } = env;
  const api = await spawnApi(43100);
  try {
    const { wallet, command: bet } = await fixture(app);
    const first = await submit(43100, bet);
    expect(first.response.status).toBe(200);
    expect((await submit(43100, bet)).result.idempotentReplay).toBe(true);
    expect(
      (
        await submit(43100, {
          ...bet,
          money: { amount: "11.00", currency: "BRL" },
        })
      ).response.status,
    ).toBe(409);
    expect(
      (
        await submit(
          43100,
          command(wallet.id, wallet.playerId, "BET", "100.00"),
        )
      ).response.status,
    ).toBe(422);
    expect(
      (
        await submit(43100, {
          ...command(wallet.id, wallet.playerId, "REFUND"),
          referenceExternalTransactionId: "missing",
        })
      ).response.status,
    ).toBe(202);
    expect(
      (
        await fetch("http://localhost:43100/wagering/transactions", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(bet),
        })
      ).status,
    ).toBe(400);
    for (const path of [
      "/health/live",
      "/health/ready",
      `/wallets/${wallet.id}`,
      `/wagering/transactions/${first.result.transactionId}`,
      `/providers/provider-a/wagering/transactions/${bet.externalTransactionId}`,
    ])
      expect((await fetch("http://localhost:43100" + path)).status).toBe(200);
    const page = await app.getLedger.execute({ walletId: wallet.id, limit: 1 });
    expect(page.nextCursor).not.toBeNull();
    const next = await app.getLedger.execute({
      walletId: wallet.id,
      limit: 1,
      cursor: page.nextCursor!,
    });
    expect(next.entries[0]?.id).not.toBe(page.entries[0]?.id);
    expect(
      await (await fetch("http://localhost:43100/metrics")).text(),
    ).toContain("wager_processing_seconds");
    await consistent(app, wallet.id);
  } finally {
    api.kill("SIGTERM");
    await api.exited;
  }
});

test("migrations down/up execute within rolled-back test transaction", async () => {
  const { app } = env;
  await expect(
    app.db.em.fork().transactional(async (em) => {
      await em.execute(
        await Bun.file("migrations/001_initial.down.sql").text(),
      );
      await em.execute(await Bun.file("migrations/001_initial.up.sql").text());
      await em.execute(
        await Bun.file("migrations/002_ledger_guards.up.sql").text(),
      );
      await em.execute(
        await Bun.file("migrations/002_ledger_guards.down.sql").text(),
      );
      await em.execute(
        await Bun.file("migrations/002_ledger_guards.up.sql").text(),
      );
      await em.execute(
        await Bun.file("migrations/003_ledger_transaction_index.up.sql").text(),
      );
      await em.execute(
        await Bun.file(
          "migrations/003_ledger_transaction_index.down.sql",
        ).text(),
      );
      await em.execute(
        await Bun.file("migrations/003_ledger_transaction_index.up.sql").text(),
      );
      throw new Error("ROLLBACK_MIGRATION_TEST");
    }),
  ).rejects.toThrow("ROLLBACK_MIGRATION_TEST");
  expect(
    (await app.db.em.fork().execute("select count(*) from wallets")).length,
  ).toBe(1);
});

test("schema rejects inverted direction and disconnected ledger balances", async () => {
  const { app } = env;
  const { wallet } = await fixture(app);
  for (const invalid of ["direction", "continuity"] as const) {
    const txId = randomUUID();
    await expect(
      app.db.em.fork().transactional(async (em) => {
        await em.execute("select id from wallets where id=? for update", [
          wallet.id,
        ]);
        await em.execute(
          `insert into wager_transactions(id,provider_id,external_transaction_id,idempotency_key,payload_hash,wallet_id,player_id,round_id,game_id,kind,amount,currency,status)
         values (?,'provider-a',?,?, 'test',?,?,'round','game','BET',10,'BRL','PROCESSED')`,
          [txId, txId, txId, wallet.id, wallet.playerId],
        );
        await em.execute(
          "update wallets set balance=?,version=version+1 where id=?",
          [invalid === "direction" ? "110.00" : "90.00", wallet.id],
        );
        await em.execute(
          "insert into wallet_ledger(id,wallet_id,transaction_id,direction,amount,currency,balance_before,balance_after) values (?,?,?,?,10,'BRL',?,?)",
          [
            randomUUID(),
            wallet.id,
            txId,
            invalid === "direction" ? "CREDIT" : "DEBIT",
            invalid === "direction" ? "100.00" : "60.00",
            invalid === "direction" ? "110.00" : "50.00",
          ],
        );
      }),
    ).rejects.toThrow(
      invalid === "direction"
        ? "invalid ledger direction"
        : "discontinuous ledger balance",
    );
    expect(
      (await app.getWallet.execute({ walletId: wallet.id })).balance.amount,
    ).toBe("100.00");
    await consistent(app, wallet.id);
  }
});

test("cursor sequence outside PostgreSQL bigint range is invalid input", async () => {
  const { app } = env;
  const { wallet } = await fixture(app);
  const cursor = Buffer.from(
    JSON.stringify({ walletId: wallet.id, sequence: "9223372036854775808" }),
  ).toString("base64url");
  const api = await spawnApi(43101);
  try {
    const response = await fetch(
      `http://localhost:43101/wallets/${wallet.id}/ledger?cursor=${cursor}`,
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      code: "INVALID_CURSOR",
      retryable: false,
    });
  } finally {
    api.kill("SIGTERM");
    await api.exited;
  }
  await consistent(app, wallet.id);
});

test("outbox uses the entity retry decision and publishes after recovery", async () => {
  const { app } = env;
  const { wallet } = await fixture(app);
  // Postpone unrelated rows so fault injection targets this wallet only.
  const expected = await app.db.em
    .fork()
    .execute<
      { id: string }[]
    >("select id from outbox where aggregate_id=? and published_at is null", [wallet.id]);
  expect(expected).toHaveLength(2);
  const failingBroker = new SqsBroker();
  failingBroker.publish = async () => {
    throw new Error("INJECTED_PUBLISH_FAILURE");
  };
  try {
    // Only a due row of this new wallet is selected; no other publishers run here.
    await app.db.em
      .fork()
      .execute(
        "update outbox set next_attempt_at=now()+interval '1 hour' where published_at is null and aggregate_id<>?",
        [wallet.id],
      );
    const before = Date.now();
    await new OutboxPublisher(app.db, failingBroker).tick();
    const rows = await app.db.em.fork().execute<
      {
        id: string;
        attempts: number;
        next_attempt_at: Date;
        published_at: Date | null;
        lease_token: string | null;
      }[]
    >("select * from outbox where aggregate_id=? and attempts=1", [wallet.id]);
    expect(rows).toHaveLength(1);
    const retried = rows[0]!;
    expect(retried.published_at).toBeNull();
    expect(retried.lease_token).toBeNull();
    expect(new Date(retried.next_attempt_at).getTime()).toBeGreaterThanOrEqual(
      before + 2000,
    );
    await app.db.em
      .fork()
      .execute("update outbox set next_attempt_at=now() where aggregate_id=?", [
        wallet.id,
      ]);
    const publisher = new OutboxPublisher(app.db, app.broker);
    await publisher.tick();
    await publisher.tick();
    const published = await app.db.em
      .fork()
      .execute(
        "select id from outbox where aggregate_id=? and published_at is not null",
        [wallet.id],
      );
    expect(published).toHaveLength(2);
    await consistent(app, wallet.id);
  } finally {
    failingBroker.close();
    await app.db.em
      .fork()
      .execute(
        "update outbox set next_attempt_at=now() where published_at is null and aggregate_id<>?",
        [wallet.id],
      );
  }
});

for (const expiredBy of ["ttl", "attempts"] as const) {
  test(`late reference is rejected after ${expiredBy} even when the BET is now processed`, async () => {
    const { app } = env;
    const { wallet, command: bet } = await fixture(app);
    const refund = {
      ...command(wallet.id, wallet.playerId, "REFUND"),
      referenceExternalTransactionId: bet.externalTransactionId,
    };
    const pending = await app.process.execute(refund);
    await app.db.em
      .fork()
      .execute(
        expiredBy === "ttl"
          ? "update wager_transactions set created_at=now()-interval '10 minutes',next_attempt_at=now() where id=?"
          : "update wager_transactions set attempts=10,next_attempt_at=now() where id=?",
        [pending.transactionId],
      );
    await app.process.execute(bet);
    await new ReferenceWorker(app.db, app.process).tick();
    const result = await app.getTransaction.execute({
      transactionId: pending.transactionId,
    });
    expect(result.status).toBe("REJECTED");
    expect(result.failureCode).toBe("REFERENCE_EXPIRED");
    expect(
      (await app.getWallet.execute({ walletId: wallet.id })).balance.amount,
    ).toBe("90.00");
    const ledger = await app.db.em
      .fork()
      .execute("select id from wallet_ledger where transaction_id=?", [
        pending.transactionId,
      ]);
    expect(ledger).toHaveLength(0);
    const events = await app.db.em
      .fork()
      .execute<
        { payload: { data: { failureCode: string } } }[]
      >("select payload from outbox where event_type='WagerTransactionRejected' and payload->'data'->>'transactionId'=?", [pending.transactionId]);
    expect(events).toHaveLength(1);
    expect(events[0]!.payload.data.failureCode).toBe("REFERENCE_EXPIRED");
    await consistent(app, wallet.id);
  });
}

test("HTTP reports reused-key conflict before a missing wallet", async () => {
  const { app } = env;
  const { wallet, command: bet } = await fixture(app);
  const api = await spawnApi(43102);
  try {
    expect((await submit(43102, bet)).response.status).toBe(200);
    const conflict = await submit(43102, { ...bet, walletId: randomUUID() });
    expect(conflict.response.status).toBe(409);
    expect(conflict.result.code).toBe("IDEMPOTENCY_CONFLICT");
    expect(
      (await app.getWallet.execute({ walletId: wallet.id })).balance.amount,
    ).toBe("90.00");
    await consistent(app, wallet.id);
  } finally {
    api.kill("SIGTERM");
    await api.exited;
  }
});

test("ledger transaction lookup has its own index", async () => {
  const rows = await env.app.db.em
    .fork()
    .execute<
      { indexdef: string }[]
    >("select indexdef from pg_indexes where schemaname=current_schema() and indexname='wallet_ledger_transaction_lookup'");
  expect(rows).toHaveLength(1);
  expect(rows[0]!.indexdef).toContain("(transaction_id)");
});

test("a slow publisher retains its lease while another publisher polls", async () => {
  const { app } = env;
  const { wallet } = await fixture(app);
  const messages = await app.db.em
    .fork()
    .execute<
      { id: string }[]
    >("select id from outbox where aggregate_id=? order by occurred_at,id limit 1", [wallet.id]);
  const id = messages[0]!.id;
  const restoreOutbox = await isolateOutboxMessage(app, id);
  const previousLease = process.env.OUTBOX_LEASE_SECONDS;
  process.env.OUTBOX_LEASE_SECONDS = "1";
  const slowBroker = new SqsBroker();
  const publish = slowBroker.publish.bind(slowBroker);
  let release!: () => void;
  let started!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const publishing = new Promise<void>((resolve) => {
    started = resolve;
  });
  let sends = 0;
  slowBroker.publish = async (...args: Parameters<SqsBroker["publish"]>) => {
    started();
    await gate;
    sends++;
    await publish(...args);
  };
  const pending = new OutboxPublisher(app.db, slowBroker).tick();
  try {
    await Promise.race([
      publishing,
      pending.then(() => {
        throw new Error("NO_MESSAGE_CLAIMED");
      }),
    ]);
    await Bun.sleep(1400);
    expect(await new OutboxPublisher(app.db, app.broker).tick()).toBe(0);
    release();
    expect(await pending).toBe(1);
    const [row] = await app.db.em
      .fork()
      .execute<
        { published_at: Date | null; attempts: number }[]
      >("select published_at,attempts from outbox where id=?", [id]);
    expect(row!.published_at).not.toBeNull();
    expect(row!.attempts).toBe(0);
    expect(sends).toBe(1);
    await consistent(app, wallet.id);
  } finally {
    release();
    await pending.catch(() => {});
    slowBroker.close();
    if (previousLease === undefined) delete process.env.OUTBOX_LEASE_SECONDS;
    else process.env.OUTBOX_LEASE_SECONDS = previousLease;
    await restoreOutbox();
  }
});

for (const outcome of ["confirm", "retry"] as const) {
  test(`a publisher that loses its token cannot ${outcome} over the new owner's confirmation`, async () => {
    const { app } = env;
    const { wallet } = await fixture(app);
    const rows = await app.db.em
      .fork()
      .execute<
        { id: string }[]
      >("select id from outbox where aggregate_id=? order by occurred_at,id limit 1", [wallet.id]);
    const id = rows[0]!.id;
    const restoreOutbox = await isolateOutboxMessage(app, id);
    const previousLease = process.env.OUTBOX_LEASE_SECONDS;
    process.env.OUTBOX_LEASE_SECONDS = "1";
    const slowBroker = new SqsBroker();
    const publish = slowBroker.publish.bind(slowBroker);
    let release!: () => void;
    let started!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const publishing = new Promise<void>((resolve) => {
      started = resolve;
    });
    slowBroker.publish = async (...args: Parameters<SqsBroker["publish"]>) => {
      started();
      await gate;
      if (outcome === "retry") throw new Error("SEND_FAILED_AFTER_LEASE_LOSS");
      await publish(...args);
    };
    const pending = new OutboxPublisher(app.db, slowBroker).tick();
    try {
      await Promise.race([
        publishing,
        pending.then(() => {
          throw new Error("NO_MESSAGE_CLAIMED");
        }),
      ]);
      // Fault injection models lost ownership without waiting for an actual database outage.
      await app.db.em
        .fork()
        .execute(
          "update outbox set lease_token=?,lease_until=now()-interval '1 second' where id=?",
          [randomUUID(), id],
        );
      expect(await new OutboxPublisher(app.db, app.broker).tick()).toBe(1);
      const confirmed = await app.db.em
        .fork()
        .execute<
          { published_at: Date; attempts: number }[]
        >("select published_at,attempts from outbox where id=?", [id]);
      release();
      await pending;
      const after = await app.db.em
        .fork()
        .execute<
          { published_at: Date; attempts: number }[]
        >("select published_at,attempts from outbox where id=?", [id]);
      expect(after[0]!.published_at).toEqual(confirmed[0]!.published_at);
      expect(after[0]!.attempts).toBe(0);
      await consistent(app, wallet.id);
    } finally {
      release();
      await pending.catch(() => {});
      slowBroker.close();
      if (previousLease === undefined) delete process.env.OUTBOX_LEASE_SECONDS;
      else process.env.OUTBOX_LEASE_SECONDS = previousLease;
      await restoreOutbox();
    }
  });
}

test("a downstream consumer deduplicates real SQS deliveries atomically by eventId", async () => {
  const { app } = env;
  const { wallet } = await fixture(app, "10.00");
  const rows = await app.db.em.fork().execute<
    {
      id: string;
      payload: {
        eventId: string;
        data: { walletId: string; money: { amount: string; currency: string } };
      };
    }[]
  >("select id,payload from outbox where aggregate_id=? and event_type='WalletBalanceChanged'", [wallet.id]);
  const event = rows[0]!.payload;
  const queueName = "downstream-test.fifo";
  let queueUrl: string | undefined;
  await app.db.em.fork().execute(`
    create table test_event_inbox(event_id uuid primary key);
    create table test_event_projection(wallet_id uuid primary key,balance numeric not null check(balance>=0));
  `);
  try {
    await app.db.em
      .fork()
      .execute("insert into test_event_projection values (?,0)", [wallet.id]);
    await app.broker.client.send(
      new CreateQueueCommand({
        QueueName: (process.env.QUEUE_PREFIX ?? "") + queueName,
        Attributes: { FifoQueue: "true", ContentBasedDeduplication: "false" },
      }),
    );
    queueUrl = await app.broker.url(queueName);
    // Different transport ids force actual redelivery beyond FIFO deduplication.
    await Promise.all(
      Array.from({ length: 3 }, (_, i) =>
        app.broker.publish(
          JSON.stringify(event),
          `delivery-${i}`,
          randomUUID(),
          queueName,
        ),
      ),
    );
    const deliveries: { body: string; receipt: string }[] = [];
    await waitFor(async () => {
      const response = await app.broker.client.send(
        new ReceiveMessageCommand({
          QueueUrl: queueUrl,
          MaxNumberOfMessages: 10,
          WaitTimeSeconds: 1,
        }),
      );
      for (const message of response.Messages ?? []) {
        deliveries.push({
          body: message.Body!,
          receipt: message.ReceiptHandle!,
        });
      }
      return deliveries.length === 3;
    });
    await Promise.all(
      deliveries.map(async (delivery) => {
        const received = JSON.parse(delivery.body) as typeof event;
        expect(received).toEqual(event);
        await app.db.em.fork().transactional(async (entityManager) => {
          const inserted = await entityManager.execute<{ event_id: string }[]>(
            "insert into test_event_inbox values (?) on conflict do nothing returning event_id",
            [received.eventId],
          );
          if (inserted.length === 0) return;
          await entityManager.execute(
            "update test_event_projection set balance=balance+?::numeric where wallet_id=?",
            [received.data.money.amount, received.data.walletId],
          );
        });
        await app.broker.client.send(
          new DeleteMessageCommand({
            QueueUrl: queueUrl,
            ReceiptHandle: delivery.receipt,
          }),
        );
      }),
    );
    const inbox = await app.db.em
      .fork()
      .execute("select * from test_event_inbox");
    const projection = await app.db.em
      .fork()
      .execute<
        { balance: string }[]
      >("select balance::text balance from test_event_projection");
    expect(deliveries).toHaveLength(3);
    expect(inbox).toHaveLength(1);
    expect(projection[0]!.balance).toBe("10.00");
    await consistent(app, wallet.id);
  } finally {
    if (queueUrl)
      await app.broker.client.send(
        new DeleteQueueCommand({ QueueUrl: queueUrl }),
      );
    await app.db.em
      .fork()
      .execute("drop table test_event_inbox,test_event_projection");
  }
});

test("a blocked outbox renewal is cancelled by PostgreSQL and another publisher recovers", async () => {
  const { app } = env;
  const { wallet } = await fixture(app);
  const [message] = await app.db.em
    .fork()
    .execute<
      { id: string }[]
    >("select id from outbox where aggregate_id=? order by occurred_at,id limit 1", [wallet.id]);
  const id = message!.id;
  const restoreOutbox = await isolateOutboxMessage(app, id);
  const previousLease = process.env.OUTBOX_LEASE_SECONDS;
  process.env.OUTBOX_LEASE_SECONDS = "3";
  let publicationStarted!: () => void, finishPublication!: () => void;
  let lockAcquired!: () => void, releaseLock!: () => void;
  const publishing = new Promise<void>((resolve) => {
    publicationStarted = resolve;
  });
  const publicationGate = new Promise<void>((resolve) => {
    finishPublication = resolve;
  });
  const locked = new Promise<void>((resolve) => {
    lockAcquired = resolve;
  });
  const lockGate = new Promise<void>((resolve) => {
    releaseLock = resolve;
  });
  const broker = new SqsBroker();
  const publish = broker.publish.bind(broker);
  broker.publish = async (...args: Parameters<SqsBroker["publish"]>) => {
    publicationStarted();
    await publicationGate;
    await publish(...args);
  };
  const pending = new OutboxPublisher(app.db, broker).tick();
  let blocker: Promise<unknown> | undefined;
  try {
    await Promise.race([
      publishing,
      pending.then(() => {
        throw new Error("NO_MESSAGE_CLAIMED");
      }),
    ]);
    const [claimed] = await app.db.em
      .fork()
      .execute<
        { lease_until: Date }[]
      >("select lease_until from outbox where id=?", [id]);
    blocker = app.db.em.fork().transactional(async (em) => {
      await em.execute("select id from outbox where id=? for update", [id]);
      lockAcquired();
      await lockGate;
    });
    await locked;
    await waitFor(async () => {
      const rows = await app.db.em
        .fork()
        .execute<
          { pid: number }[]
        >("select pid from pg_stat_activity where datname=current_database() and pid<>pg_backend_pid() and cardinality(pg_blocking_pids(pid))>0 and query like ?", ["%lease_until=clock_timestamp()%"]);
      return rows.length > 0;
    });
    finishPublication();
    // The row remains locked: completion requires a real SQL timeout, not lock release.
    expect(await pending).toBe(1);
    const [afterTimeout] = await app.db.em.fork().execute<
      {
        lease_until: Date;
        published_at: Date | null;
        attempts: number;
      }[]
    >("select lease_until,published_at,attempts from outbox where id=?", [id]);
    expect(afterTimeout!.lease_until).toEqual(claimed!.lease_until);
    expect(afterTimeout!.published_at).toBeNull();
    expect(afterTimeout!.attempts).toBe(0);
    releaseLock();
    await blocker;
    await app.db.em
      .fork()
      .execute(
        "update outbox set lease_until=now()-interval '1 second' where id=?",
        [id],
      );
    expect(await new OutboxPublisher(app.db, app.broker).tick()).toBe(1);
    const [recovered] = await app.db.em
      .fork()
      .execute<
        { published_at: Date | null }[]
      >("select published_at from outbox where id=?", [id]);
    expect(recovered!.published_at).not.toBeNull();
    await consistent(app, wallet.id);
  } finally {
    finishPublication();
    releaseLock();
    await blocker?.catch(() => {});
    await pending.catch(() => {});
    broker.close();
    if (previousLease === undefined) delete process.env.OUTBOX_LEASE_SECONDS;
    else process.env.OUTBOX_LEASE_SECONDS = previousLease;
    await restoreOutbox();
  }
});
