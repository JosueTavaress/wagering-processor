import { test, expect } from "bun:test";
import {
  errorChain,
  infrastructureErrorCode,
  infrastructureErrorName,
  isPermanentInfrastructureError,
  isTransientInfrastructureError,
} from "../../src/infra/InfrastructureError";
import { classifyConsumerFailure } from "../../src/infra/workers/ConsumerFailure";
import { DomainError } from "../../src/domain/entity/DomainError";

for (const circular of ["self", "two-errors"] as const) {
  test(`circular ${circular} cause cannot hang HTTP or consumer classification`, async () => {
    const infrastructure = new URL(
      "../../src/infra/InfrastructureError.ts",
      import.meta.url,
    ).href;
    const consumer = new URL(
      "../../src/infra/workers/ConsumerFailure.ts",
      import.meta.url,
    ).href;
    const child = Bun.spawn(
      [
        process.execPath,
        "-e",
        `
      import { errorChain, infrastructureErrorCode, infrastructureErrorName, isPermanentInfrastructureError, isTransientInfrastructureError } from ${JSON.stringify(infrastructure)};
      import { classifyConsumerFailure } from ${JSON.stringify(consumer)};
      const a = new Error("a"), b = new Error("b");
      a.cause = ${circular === "self" ? "a" : "b"}; b.cause = a;
      if ([...errorChain(a)].length !== ${circular === "self" ? 1 : 2}) throw new Error("wrong chain");
      if (infrastructureErrorCode(a) !== undefined) throw new Error("wrong code");
      if (infrastructureErrorName(a) !== "Error") throw new Error("wrong name");
      if (isTransientInfrastructureError(a) || isPermanentInfrastructureError(a)) throw new Error("wrong classification");
      if (classifyConsumerFailure(a).category !== "unknown") throw new Error("wrong consumer decision");
    `,
      ],
      { stdout: "ignore", stderr: "pipe" },
    );
    // Kill a regressed synchronous loop from outside its event loop.
    const timer = setTimeout(() => child.kill("SIGKILL"), 4000);
    try {
      expect(await child.exited).toBe(0);
      expect(await new Response(child.stderr).text()).toBe("");
    } finally {
      clearTimeout(timer);
      if (child.exitCode === null && child.signalCode === null)
        child.kill("SIGKILL");
    }
  });
}

test("long cause chains are iterative and inspect nested codes", () => {
  let error: Error = Object.assign(new Error(), { code: "08006" });
  for (let index = 0; index < 10000; index++)
    error = new Error("wrapper", { cause: error });
  expect(infrastructureErrorCode(error)).toBe("08006");
  expect(isTransientInfrastructureError(error)).toBe(true);
  expect(isPermanentInfrastructureError(error)).toBe(false);
});

test("transient cause remains discoverable behind an unrecognized outer code", () => {
  const error = Object.assign(
    new Error("wrapper", { cause: { code: "08006" } }),
    { code: "WRAPPED" },
  );
  expect(isTransientInfrastructureError(error)).toBe(true);
});

for (const cause of [
  new TypeError("bug"),
  new ReferenceError("bug"),
  new RangeError("bug"),
  new DomainError("UNBALANCED_LEDGER"),
]) {
  test(`wrapped ${cause.name}/${cause.message} is programming, without retry`, () => {
    const result = classifyConsumerFailure(
      new Error("wrapper", { cause: new Error("wrapper", { cause }) }),
    );
    expect(result).toMatchObject({
      category: "programming",
      retryable: false,
      errorCode: cause instanceof DomainError ? cause.code : cause.name,
    });
  });
}

test("wrapped business and invalid-message errors retain their policy", () => {
  expect(
    classifyConsumerFailure(
      new Error("wrapper", { cause: new DomainError("INBOX_CONFLICT") }),
    ),
  ).toMatchObject({
    category: "domain",
    retryable: false,
    reason: "INBOX_CONFLICT",
  });
  expect(
    classifyConsumerFailure(
      new Error("wrapper", { cause: new SyntaxError("JSON") }),
    ),
  ).toMatchObject({ category: "invalid-message", retryable: false });
});

test("programming outranks domain and infrastructure; permanent outranks transient", () => {
  const domain = new DomainError("INBOX_CONFLICT");
  domain.cause = Object.assign(new TypeError("bug"), { code: "ECONNRESET" });
  expect(classifyConsumerFailure(domain)).toMatchObject({
    category: "programming",
    errorCode: "TypeError",
    retryable: false,
  });
  const denied = Object.assign(new Error(), { name: "AccessDeniedException" });
  const transient = Object.assign(new Error("wrapper", { cause: denied }), {
    code: "ECONNRESET",
  });
  expect(classifyConsumerFailure(transient)).toMatchObject({
    category: "permanent",
    errorCode: "AccessDeniedException",
    retryable: false,
  });
});

test("recognized error is preserved even when its cause is circular", () => {
  const error = Object.assign(new Error(), { code: "42501" });
  error.cause = error;
  expect([...errorChain(error)]).toHaveLength(1);
  expect(isPermanentInfrastructureError(error)).toBe(true);
  expect(classifyConsumerFailure(error)).toMatchObject({
    category: "permanent",
    errorCode: "42501",
  });
});
