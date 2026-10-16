import { test, expect } from "bun:test";
import { readRecoveryConfig } from "../../src/infra/RecoveryConfig";
import { compose } from "../../src/infra/composition";

const names = [
  "REFERENCE_TTL_MS",
  "REFERENCE_MAX_ATTEMPTS",
  "OUTBOX_LEASE_SECONDS",
  "QUEUE_VISIBILITY_SECONDS",
  "MAX_RECEIVE_COUNT",
];
for (const name of names) {
  for (const value of [
    "abc",
    "NaN",
    "Infinity",
    "",
    " ",
    "0",
    "-1",
    "1.5",
    "1e3",
    "9007199254740992",
  ]) {
    test(`${name} rejects ${JSON.stringify(value)}`, () => {
      expect(() => readRecoveryConfig({ [name]: value })).toThrow(name);
    });
  }
}
test("recovery defaults and explicit positive integers", () => {
  expect(readRecoveryConfig({})).toEqual({
    referenceTTL: 300000,
    referenceAttempts: 10,
    outboxLeaseSeconds: 30,
    queueVisibilitySeconds: 30,
    maxReceiveCount: 5,
  });
  expect(
    readRecoveryConfig({
      REFERENCE_TTL_MS: "1",
      REFERENCE_MAX_ATTEMPTS: "2",
      OUTBOX_LEASE_SECONDS: "3",
      QUEUE_VISIBILITY_SECONDS: "4",
      MAX_RECEIVE_COUNT: "5",
    }),
  ).toEqual({
    referenceTTL: 1,
    referenceAttempts: 2,
    outboxLeaseSeconds: 3,
    queueVisibilitySeconds: 4,
    maxReceiveCount: 5,
  });
});
test("service limits reject oversized visibility, lease and redrive count", () => {
  for (const [name, value] of [
    ["QUEUE_VISIBILITY_SECONDS", "43201"],
    ["OUTBOX_LEASE_SECONDS", "86401"],
    ["MAX_RECEIVE_COUNT", "1001"],
  ] as const) {
    expect(() => readRecoveryConfig({ [name]: value })).toThrow(name);
  }
});
test("composition rejects bad configuration before connecting to infrastructure", async () => {
  const previous = process.env.REFERENCE_TTL_MS;
  process.env.REFERENCE_TTL_MS = "abc";
  try {
    await expect(compose()).rejects.toThrow(
      "Invalid configuration: REFERENCE_TTL_MS",
    );
  } finally {
    if (previous === undefined) delete process.env.REFERENCE_TTL_MS;
    else process.env.REFERENCE_TTL_MS = previous;
  }
});
