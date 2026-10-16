import { describe, test, expect } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  UnitOfWork,
  TransactionContext,
} from "../../src/application/port/UnitOfWork";
import { ProcessWagerTransaction } from "../../src/application/process-wager-transaction/ProcessWagerTransaction";
import { Wallet } from "../../src/domain/entity/Wallet";
import { DomainError } from "../../src/domain/entity/DomainError";
import { Money } from "../../src/domain/entity/Money";
import { WagerTransaction } from "../../src/domain/entity/WagerTransaction";
import { WalletLedgerEntry } from "../../src/domain/entity/WalletLedgerEntry";
import { OutboxMessage } from "../../src/domain/entity/OutboxMessage";

function scenario() {
  const wallet = Wallet.open({
    id: randomUUID(),
    playerId: randomUUID(),
    initialBalance: Money.from({ amount: "100.00", currency: "BRL" }),
  });
  const transactions: WagerTransaction[] = [],
    entries: WalletLedgerEntry[] = [],
    events: OutboxMessage[] = [];
  const db: TransactionContext = {
    wallets: {
      lock: async (id) => (id === wallet.id ? wallet : undefined),
      save: async () => {},
      insert: async () => {},
    },
    transactions: {
      findIdentity: async (key, p, e) =>
        transactions.filter(
          (t) =>
            t.snapshot().idempotencyKey === key ||
            (t.snapshot().providerId === p &&
              t.snapshot().externalTransactionId === e),
        ),
      findReference: async (p, e) =>
        transactions.find(
          (t) =>
            t.snapshot().providerId === p &&
            t.snapshot().externalTransactionId === e,
        ),
      hasReversal: async (id, kind) =>
        transactions.some(
          (t) =>
            t.referenceTransactionId === id &&
            t.kind === kind &&
            t.status === "PROCESSED",
        ),
      save: async (t) => {
        if (!transactions.includes(t)) transactions.push(t);
      },
    },
    ledger: {
      append: async (e) => {
        entries.push(e);
      },
    },
    outbox: {
      enqueue: async (e) => {
        events.push(e);
      },
    },
    inbox: { record: async () => {} },
  };
  const uow: UnitOfWork = { run: (work) => work(db) };
  const process = new ProcessWagerTransaction(uow);
  const input = {
    providerId: "p",
    externalTransactionId: "e",
    idempotencyKey: "key",
    walletId: wallet.id,
    playerId: wallet.playerId,
    roundId: "r",
    gameId: "g",
    kind: "BET" as const,
    money: { amount: "10.00", currency: "BRL" },
  };
  return { process, input, wallet, entries, events, transactions };
}
describe("Idempotency and business rejection", () => {
  test("usecase conflict is not replay and does not apply another debit", async () => {
    const s = scenario();
    await s.process.execute(s.input);
    await expect(
      s.process.execute({ ...s.input, gameId: "changed" }),
    ).rejects.toThrow("IDEMPOTENCY_CONFLICT");
    expect(s.entries).toHaveLength(1);
    expect(s.wallet.balance.toString()).toBe("90.00");
  });

  test("usecase persists original result and avoids additional events on replay", async () => {
    const s = scenario();
    const first = await s.process.execute(s.input);
    await s.process.execute({
      ...s.input,
      externalTransactionId: "second",
      idempotencyKey: "second",
    });
    const replay = await s.process.execute(s.input);
    expect(replay.balance).toEqual(first.balance);
    expect(replay.idempotentReplay).toBe(true);
    expect(s.entries).toHaveLength(2);
    expect(s.events).toHaveLength(4);
  });

  test("business rejection creates rejection event without ledger", async () => {
    const s = scenario();
    const result = await s.process.execute({
      ...s.input,
      money: { amount: "101.00", currency: "BRL" },
    });
    expect(result.status).toBe("REJECTED");
    expect(s.entries).toHaveLength(0);
    expect(s.events[0]?.snapshot().eventType).toBe("WagerTransactionRejected");
  });
});

describe("Missing and incompatible references", () => {
  test("reference absence persists pending and emits one pending event", async () => {
    const s = scenario();
    const input = {
      ...s.input,
      kind: "REFUND" as const,
      referenceExternalTransactionId: "missing",
    };
    expect((await s.process.execute(input)).status).toBe("PENDING_REFERENCE");
    await s.process.execute(input);
    expect(s.events).toHaveLength(1);
    expect(s.events[0]?.snapshot().eventType).toBe(
      "WagerTransactionPendingReference",
    );
    expect(s.entries).toHaveLength(0);
  });

  for (const mismatch of ["walletId", "playerId", "roundId"] as const) {
    test(`pending reference with incompatible ${mismatch} rejects immediately`, async () => {
      const s = scenario();
      const reference = WagerTransaction.create({
        ...s.input,
        id: randomUUID(),
        [mismatch]: randomUUID(),
        money: Money.from(s.input.money),
        payloadHash: "reference",
      });
      reference.markPendingReference(s.wallet.balance);
      s.transactions.push(reference);
      const result = await s.process.execute({
        ...s.input,
        kind: "REFUND",
        externalTransactionId: "refund",
        idempotencyKey: "refund",
        referenceExternalTransactionId: s.input.externalTransactionId,
      });
      expect(result.status).toBe("REJECTED");
      if (result.status === "REJECTED")
        expect(result.failureCode).toBe("REFERENCE_MISMATCH");
      expect(s.entries).toHaveLength(0);
      expect(s.events[0]?.snapshot().eventType).toBe(
        "WagerTransactionRejected",
      );
    });
  }

  for (const kind of ["BET", "LOSS"] as const) {
    test(`domain rejects reference on ${kind} without transport validation`, () => {
      const s = scenario();
      expect(() =>
        WagerTransaction.create({
          ...s.input,
          id: randomUUID(),
          kind,
          money: Money.from({
            amount: kind === "LOSS" ? "0.00" : "10.00",
            currency: "BRL",
          }),
          payloadHash: "hash",
          referenceExternalTransactionId: "another-operation",
        }),
      ).toThrow("UNEXPECTED_REFERENCE");
    });
  }
});

describe("Programming errors", () => {
  for (const code of [
    "INVALID_TRANSACTION_STATE",
    "UNBALANCED_LEDGER",
    "NO_LEDGER_DIRECTION",
  ]) {
    test(`programming error ${code} escapes processing without a business rejection`, async () => {
      const s = scenario();
      s.wallet.debit = () => {
        throw new DomainError(code);
      };
      await expect(s.process.execute(s.input)).rejects.toThrow(code);
      expect(s.transactions).toHaveLength(0);
      expect(s.entries).toHaveLength(0);
      expect(s.events).toHaveLength(0);
      expect(s.wallet.balance.toString()).toBe("100.00");
    });
  }
});

describe("Reference retry and expiration", () => {
  test("an exhausted pending reference is rejected without another pending notification", async () => {
    const {
      process: processor,
      input,
      transactions,
      entries,
      events,
      wallet,
    } = scenario();
    const refund = {
      ...input,
      kind: "REFUND" as const,
      referenceExternalTransactionId: "missing",
    };
    const pending = await processor.execute(refund);
    expect(pending.status).toBe("PENDING_REFERENCE");
    transactions[0] = WagerTransaction.rehydrate({
      ...transactions[0]!.snapshot(),
      attempts: 10,
      nextAttemptAt: new Date(0),
    });
    const rejected = await processor.execute(refund, {
      correlationId: "retry",
      retryReference: true,
    });
    expect(rejected.status).toBe("REJECTED");
    if (rejected.status === "REJECTED")
      expect(rejected.failureCode).toBe("REFERENCE_EXPIRED");
    expect(entries).toHaveLength(0);
    expect(wallet.balance.toString()).toBe("100.00");
    expect(events.map((event) => event.snapshot().eventType)).toEqual([
      "WagerTransactionPendingReference",
      "WagerTransactionRejected",
    ]);
  });

  test("a due reference retry resolves without duplicate pending or financial events", async () => {
    const {
      process: processor,
      input,
      transactions,
      entries,
      events,
      wallet,
    } = scenario();
    const refund = {
      ...input,
      kind: "REFUND" as const,
      externalTransactionId: "refund",
      idempotencyKey: "refund",
      referenceExternalTransactionId: input.externalTransactionId,
    };
    expect((await processor.execute(refund)).status).toBe("PENDING_REFERENCE");
    await processor.execute(input);
    transactions[0] = WagerTransaction.rehydrate({
      ...transactions[0]!.snapshot(),
      nextAttemptAt: new Date(0),
    });
    expect(
      (
        await processor.execute(refund, {
          correlationId: "retry",
          retryReference: true,
        })
      ).status,
    ).toBe("PROCESSED");
    const replay = await processor.execute(refund);
    expect(replay.idempotentReplay).toBe(true);
    expect(wallet.balance.toString()).toBe("100.00");
    expect(entries).toHaveLength(2);
    expect(events.map((event) => event.snapshot().eventType)).toEqual([
      "WagerTransactionPendingReference",
      "WagerTransactionProcessed",
      "WalletBalanceChanged",
      "WagerTransactionProcessed",
      "WalletBalanceChanged",
    ]);
  });

  for (const expiredBy of ["ttl", "attempts"] as const) {
    test(`a late reference cannot revive a pending reversal expired by ${expiredBy}`, async () => {
      const {
        process: processor,
        input,
        transactions,
        entries,
        events,
        wallet,
      } = scenario();
      const refund = {
        ...input,
        kind: "REFUND" as const,
        externalTransactionId: "refund",
        idempotencyKey: "refund",
        referenceExternalTransactionId: input.externalTransactionId,
      };
      await processor.execute(refund);
      transactions[0] = WagerTransaction.rehydrate({
        ...transactions[0]!.snapshot(),
        nextAttemptAt: new Date(0),
        ...(expiredBy === "ttl"
          ? { createdAt: new Date(0) }
          : { attempts: 10 }),
      });
      await processor.execute(input);
      const result = await processor.execute(refund, {
        correlationId: "retry",
        retryReference: true,
      });
      expect(result.status).toBe("REJECTED");
      if (result.status === "REJECTED")
        expect(result.failureCode).toBe("REFERENCE_EXPIRED");
      expect(entries).toHaveLength(1);
      expect(wallet.balance.toString()).toBe("90.00");
      expect(
        events.filter(
          (event) => event.snapshot().eventType === "WagerTransactionRejected",
        ),
      ).toHaveLength(1);
      expect((await processor.execute(refund)).idempotentReplay).toBe(true);
    });
  }
});

describe("Identity conflict before wallet lookup", () => {
  test("a reused key with another missing wallet is an idempotency conflict", async () => {
    const { process: processor, input, entries, wallet } = scenario();
    await processor.execute(input);
    await expect(
      processor.execute({ ...input, walletId: randomUUID() }),
    ).rejects.toThrow("IDEMPOTENCY_CONFLICT");
    expect(entries).toHaveLength(1);
    expect(wallet.balance.toString()).toBe("90.00");
  });
});
