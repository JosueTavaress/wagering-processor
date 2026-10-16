import { describe, test, expect } from "bun:test";
import { randomUUID } from "node:crypto";
import { Money } from "../../src/domain/entity/Money";
import { Wallet } from "../../src/domain/entity/Wallet";
import { WagerTransaction } from "../../src/domain/entity/WagerTransaction";
import { WalletLedgerEntry } from "../../src/domain/entity/WalletLedgerEntry";
import { WagerPolicy } from "../../src/domain/service/WagerPolicy";
import { InboxMessage } from "../../src/domain/entity/InboxMessage";
import { OutboxMessage } from "../../src/domain/entity/OutboxMessage";
import { WagerTransactionProcessed } from "../../src/domain/event/WagerTransactionProcessed";
import { commandSchema, moneySchema } from "../../src/infra/http/Validation";
import {
  businessHash,
  hash,
} from "../../src/application/process-wager-transaction/CanonicalPayload";
const money = (amount: string, currency = "BRL") =>
  Money.from({ amount, currency });
const wallet = () =>
  Wallet.open({
    id: randomUUID(),
    playerId: randomUUID(),
    initialBalance: money("100.00"),
  });
function tx(
  w: Wallet,
  kind: "BET" | "WIN" | "LOSS" | "REFUND" | "ROLLBACK" = "BET",
  amount = "10.00",
  referenceExternalTransactionId?: string,
) {
  return WagerTransaction.create({
    id: randomUUID(),
    providerId: "provider",
    externalTransactionId: randomUUID(),
    idempotencyKey: randomUUID(),
    payloadHash: "hash",
    walletId: w.id,
    playerId: w.playerId,
    roundId: "round",
    gameId: "game",
    kind,
    money: money(amount),
    referenceExternalTransactionId,
  });
}
describe("Money", () => {
  test("exact arithmetic, normalization and immutability", () => {
    const a = money("0.10");
    expect(a.add(money("0.20")).toString()).toBe("0.30");
    expect(a.toString()).toBe("0.10");
    expect(money("10").toJSON()).toEqual({ amount: "10.00", currency: "BRL" });
    expect(money("10.1").toString()).toBe("10.10");
    expect(money("0").negate().toString()).toBe("0.00");
    expect(money("-1.25").toString()).toBe("-1.25");
  });
  for (const value of [
    "NaN",
    "Infinity",
    "1e2",
    "",
    "1.001",
    "1.999",
    " 1.00",
    "01.00",
    "+1.00",
  ])
    test(`reject ${JSON.stringify(value)}`, () =>
      expect(() => money(value)).toThrow());
  test("no precision loss beyond JS safe integer", () =>
    expect(money("9007199254740993.99").add(money("0.01")).toString()).toBe(
      "9007199254740994.00",
    ));
  test("currency conflict", () => {
    expect(() => money("1").add(money("1", "USD"))).toThrow(
      "CURRENCY_MISMATCH",
    );
    expect(() => money("1").equals(money("1", "USD"))).toThrow();
  });
  test("contracts reject negative amounts, nonstring, excess precision and nonfixed scale", () => {
    for (const amount of ["-1.00", "1.001", "1", "1.0", 1])
      expect(moneySchema.safeParse({ amount, currency: "BRL" }).success).toBe(
        false,
      );
  });
});
describe("Wallet and ledger", () => {
  test("version and non-negative balance", () => {
    const w = wallet();
    expect(w.version).toBe(1);
    w.debit(money("80"));
    expect(w.version).toBe(2);
    expect(() => w.debit(money("80"))).toThrow("INSUFFICIENT_FUNDS");
    expect(w.balance.toString()).toBe("20.00");
    expect(w.version).toBe(2);
    w.credit(money("5"));
    expect(w.version).toBe(3);
  });
  test("currency/zero/negative guarded", () => {
    const w = wallet();
    expect(() => w.credit(money("1", "USD"))).toThrow();
    expect(() => w.debit(money("-1"))).toThrow();
    expect(() => w.credit(money("0"))).toThrow();
    expect(() =>
      Wallet.open({ id: "x", playerId: "p", initialBalance: money("-1") }),
    ).toThrow();
  });
  test("ledger arithmetic and immutability", () => {
    const state = {
      id: "1",
      walletId: "w",
      transactionId: "t",
      direction: "DEBIT" as const,
      money: money("10"),
      balanceBefore: money("100"),
      balanceAfter: money("90"),
      createdAt: new Date(),
    };
    const e = WalletLedgerEntry.create(state);
    expect(e.isBalanced()).toBe(true);
    expect(Object.isFrozen(e)).toBe(true);
    expect(() =>
      WalletLedgerEntry.create({ ...state, balanceAfter: money("80") }),
    ).toThrow();
  });
});
describe("Wager rules", () => {
  for (const kind of ["BET", "WIN", "LOSS"] as const)
    test(kind, () => {
      const w = wallet(),
        t = tx(w, kind, kind === "LOSS" ? "0.00" : "10.00");
      WagerPolicy.apply(t, w);
      expect(w.balance.toString()).toBe(
        kind === "BET" ? "90.00" : kind === "WIN" ? "110.00" : "100.00",
      );
      expect(w.version).toBe(kind === "LOSS" ? 1 : 2);
    });
  test("refund and rollback directions", () => {
    const w = wallet(),
      bet = tx(w);
    bet.markProcessed(undefined, new Date(), w.balance);
    const refund = tx(w, "REFUND", "10", bet.snapshot().externalTransactionId);
    WagerPolicy.validateReference(refund, bet);
    WagerPolicy.apply(refund, w, bet);
    expect(w.balance.toString()).toBe("110.00");
    refund.markProcessed(bet.id, new Date(), w.balance);
    const rollback = tx(
      w,
      "ROLLBACK",
      "10",
      refund.snapshot().externalTransactionId,
    );
    WagerPolicy.validateReference(rollback, refund);
    WagerPolicy.apply(rollback, w, refund);
    expect(w.balance.toString()).toBe("100.00");
  });
  test("distinct reversal insufficiency", () => {
    const w = wallet(),
      win = tx(w, "WIN", "200");
    win.markProcessed(undefined, new Date(), w.balance);
    expect(() =>
      WagerPolicy.apply(
        tx(w, "ROLLBACK", "200", win.snapshot().externalTransactionId),
        w,
        win,
      ),
    ).toThrow("REVERSAL_INSUFFICIENT_FUNDS");
  });
  test("reference validation", () => {
    const w = wallet(),
      bet = tx(w);
    bet.markProcessed(undefined, new Date(), w.balance);
    expect(() =>
      WagerPolicy.validateReference(tx(w, "REFUND", "11", "ref"), bet),
    ).toThrow("REFERENCE_AMOUNT_MISMATCH");
    const other = wallet();
    expect(() =>
      WagerPolicy.validateReference(tx(other, "REFUND", "10", "ref"), bet),
    ).toThrow("REFERENCE_MISMATCH");
    expect(() => tx(w, "REFUND")).toThrow("REFERENCE_REQUIRED");
  });
  test("terminal transitions cannot repeat", () => {
    const w = wallet();
    for (const status of ["process", "reject", "fail"]) {
      const t = tx(w);
      if (status === "process")
        t.markProcessed(undefined, new Date(), w.balance);
      if (status === "reject") t.reject("CODE", w.balance);
      if (status === "fail") t.fail("INFRA_PERMANENT");
      expect(t.isTerminal()).toBe(true);
      expect(() => t.markPendingReference(w.balance)).toThrow(
        "INVALID_TRANSACTION_STATE",
      );
      expect(() => t.reject("X", w.balance)).toThrow();
    }
  });
  test("pending and rehydrate preserve state", () => {
    const w = wallet(),
      t = tx(w);
    t.markPendingReference(w.balance);
    const copy = WagerTransaction.rehydrate(t.snapshot());
    expect(copy.status).toBe("PENDING_REFERENCE");
    copy.markProcessed(undefined, new Date(), w.balance);
    expect(copy.status).toBe("PROCESSED");
  });
  test("canonical hash ignores key, detects changed business and input rejects OPENING", () => {
    const w = wallet();
    const input = {
      providerId: "provider",
      externalTransactionId: "e",
      idempotencyKey: "key",
      walletId: w.id,
      playerId: w.playerId,
      roundId: "r",
      gameId: "g",
      kind: "BET" as const,
      money: { amount: "1.00", currency: "BRL" },
    };
    expect(businessHash(input)).toBe(
      businessHash({ ...input, idempotencyKey: "other" }),
    );
    expect(businessHash(input)).not.toBe(
      businessHash({ ...input, gameId: "other" }),
    );
    expect(hash({ a: 1, b: 2 })).toBe(hash({ b: 2, a: 1 }));
    expect(commandSchema.safeParse({ ...input, kind: "OPENING" }).success).toBe(
      false,
    );
  });
  test("inbox and outbox lifecycle", () => {
    const i = InboxMessage.receive({
      messageId: "m",
      consumerName: "c",
      payloadHash: "h",
    });
    expect(i.isProcessed()).toBe(false);
    i.markProcessed(new Date());
    expect(i.isProcessed()).toBe(true);
    expect(() => i.markProcessed(new Date())).toThrow();
    const event = WagerTransactionProcessed.create({
      eventId: randomUUID(),
      aggregateId: randomUUID(),
      correlationId: "c",
      occurredAt: new Date(),
      data: {
        transactionId: "t",
        walletId: "w",
        money: money("1").toJSON(),
        balance: money("1").toJSON(),
        walletVersion: 1,
      },
    });
    const o = OutboxMessage.enqueue(event);
    o.scheduleRetry(new Date());
    expect(o.snapshot().attempts).toBe(1);
    o.markPublished(new Date());
    expect(o.isPending()).toBe(false);
    expect(event.toJSON().version).toBe(1);
  });
});

test("ORM money mapping preserves strings without floating-point comparison", async () => {
  const { ExactDecimalType } = await import(
    "../../src/infra/database/ExactDecimalType"
  );
  const type = new ExactDecimalType();
  expect(type.convertToJSValue("9007199254740993.99")).toBe(
    "9007199254740993.99",
  );
  expect(type.convertToDatabaseValue("0.10")).toBe("0.10");
  expect(type.compareValues("9007199254740992.00", "9007199254740993.00")).toBe(
    false,
  );
});

test("rejected currency mismatch rehydrates the original wallet balance currency", async () => {
  const { transactionFromRow } = await import(
    "../../src/infra/repository/PostgresTransactionRepository"
  );
  const t = transactionFromRow({
    id: "t",
    provider_id: "p",
    external_transaction_id: "e",
    idempotency_key: "k",
    payload_hash: "h",
    wallet_id: "w",
    player_id: "player",
    round_id: "r",
    game_id: "g",
    kind: "BET",
    amount: "10.00",
    currency: "USD",
    reference_external_transaction_id: null,
    reference_transaction_id: null,
    status: "REJECTED",
    failure_code: "CURRENCY_MISMATCH",
    balance: "100.00",
    balance_currency: "BRL",
    created_at: new Date(),
    processed_at: new Date(),
    attempts: 0,
    next_attempt_at: new Date(),
  });
  expect(t.snapshot().balance?.toJSON()).toEqual({
    amount: "100.00",
    currency: "BRL",
  });
});

test("transaction snapshots cannot mutate its retry deadline or creation date", () => {
  const w = wallet();
  const transaction = tx(w, "REFUND", "10", "reference");
  const now = new Date("2026-10-16T00:00:00.000Z");
  transaction.markPendingReference(w.balance, now);
  const original = transaction.snapshot();
  const exposed = transaction.snapshot();
  exposed.createdAt.setTime(0);
  exposed.nextAttemptAt.setTime(0);
  expect(transaction.snapshot().createdAt.getTime()).toBe(
    original.createdAt.getTime(),
  );
  expect(transaction.isReferenceRetryDue(now)).toBe(false);
  expect(transaction.isReferenceRetryDue(new Date(now.getTime() + 1000))).toBe(
    true,
  );
});

test("inbox completion date is copied on input and output", () => {
  const inbox = InboxMessage.receive({
    messageId: "m",
    consumerName: "c",
    payloadHash: "h",
  });
  const at = new Date("2026-10-16T00:00:00.000Z");
  inbox.markProcessed(at);
  at.setTime(0);
  inbox.processedAt!.setTime(0);
  expect(inbox.snapshot().processedAt?.toISOString()).toBe(
    "2026-10-16T00:00:00.000Z",
  );
});
