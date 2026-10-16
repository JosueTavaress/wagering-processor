import { test, expect } from "bun:test";
import { WagerTransactionRejected } from "../../src/domain/event/WagerTransactionRejected";
import { WalletBalanceChanged } from "../../src/domain/event/WalletBalanceChanged";

const money = { amount: "10.00", currency: "BRL" };
const context = {
  eventId: "event",
  aggregateId: "wallet",
  correlationId: "correlation",
  occurredAt: new Date("2026-10-16T00:00:00.000Z"),
};
const transaction = {
  transactionId: "transaction",
  walletId: "wallet",
  money,
  balance: money,
  walletVersion: 2,
};

test("rejection event serializes its required failure code", () => {
  const event = WagerTransactionRejected.create({
    ...context,
    data: { ...transaction, failureCode: "INSUFFICIENT_FUNDS" },
  });
  expect(event.toJSON()).toMatchObject({
    eventType: "WagerTransactionRejected",
    version: 1,
    data: { failureCode: "INSUFFICIENT_FUNDS" },
  });
});

test("balance event serializes direction and both balances", () => {
  const event = WalletBalanceChanged.create({
    ...context,
    data: {
      ...transaction,
      direction: "DEBIT",
      balanceBefore: { ...money, amount: "20.00" },
      balanceAfter: money,
    },
  });
  expect(event.toJSON().data).toMatchObject({
    direction: "DEBIT",
    balanceBefore: { amount: "20.00", currency: "BRL" },
    balanceAfter: money,
  });
});

// These calls must fail typechecking if the essential fields become optional.
// The function is deliberately not executed: this is a compile-time contract test.
function incompleteEventsAreInvalid() {
  // @ts-expect-error A rejection must carry failureCode.
  WagerTransactionRejected.create({ ...context, data: transaction });
  // @ts-expect-error A balance change must carry direction and both balances.
  WalletBalanceChanged.create({ ...context, data: transaction });
}
void incompleteEventsAreInvalid;
