import { test, expect, spyOn } from "bun:test";
import { HttpException, type ArgumentsHost } from "@nestjs/common";
import { ZodError } from "zod";
import { ApiExceptionFilter } from "../../src/infra/http/ApiExceptionFilter";
import { telemetry } from "../../src/infra/observability/Telemetry";
import { DomainError } from "../../src/domain/entity/DomainError";

function responseFor(
  error: unknown,
  request: {
    headers?: Record<string, string>;
    params?: Record<string, string>;
    body?: unknown;
  } = {},
) {
  const result = {
    status: 0,
    headers: {} as Record<string, string>,
    body: undefined as unknown,
  };
  const response = {
    locals: {},
    setHeader(name: string, value: string) {
      result.headers[name] = value;
    },
    status(status: number) {
      result.status = status;
      return this;
    },
    json(body: unknown) {
      result.body = body;
    },
  };
  const host = {
    switchToHttp: () => ({
      getResponse: () => response,
      getRequest: () => request,
    }),
  } as unknown as ArgumentsHost;
  new ApiExceptionFilter().catch(error, host);
  return result;
}

for (const [code, status] of [
  ["INSUFFICIENT_FUNDS", 422],
  ["REVERSAL_INSUFFICIENT_FUNDS", 422],
  ["IDEMPOTENCY_CONFLICT", 409],
  ["UNIQUENESS_CONFLICT", 409],
  ["INBOX_CONFLICT", 409],
  ["WALLET_NOT_FOUND", 404],
  ["TRANSACTION_NOT_FOUND", 404],
  ["INVALID_CURSOR", 400],
  ["INVALID_TRANSACTION_STATE", 500],
  ["UNBALANCED_LEDGER", 500],
  ["NO_LEDGER_DIRECTION", 500],
  ["INBOX_ALREADY_PROCESSED", 500],
] as const) {
  test(`HTTP maps ${code} to ${status} without asking for infrastructure retry`, () => {
    const response = responseFor(new DomainError(code));
    expect(response.status).toBe(status);
    expect(response.body).toEqual({ code, retryable: false });
    expect(response.headers["Retry-After"]).toBeUndefined();
  });
}

test("invalid contracts remain HTTP 400", () => {
  const response = responseFor(new ZodError([]));
  expect(response.status).toBe(400);
  expect(response.body).toEqual({ code: "INVALID_PAYLOAD", retryable: false });
});

for (const code of [
  "ECONNREFUSED",
  "ECONNRESET",
  "40P01",
  "55P03",
  "40001",
  "08006",
  "53300",
]) {
  test(`transient ${code} returns HTTP 503 and Retry-After`, () => {
    const response = responseFor({ cause: { code } });
    expect(response.status).toBe(503);
    expect(response.body).toEqual({
      code: "INFRASTRUCTURE_UNAVAILABLE",
      retryable: true,
    });
    expect(response.headers["Retry-After"]).toBe("1");
  });
}

test("SQS service unavailability is retryable but access denial is not", () => {
  expect(responseFor({ $metadata: { httpStatusCode: 503 } }).status).toBe(503);
  expect(responseFor({ $metadata: { httpStatusCode: 403 } }).status).toBe(500);
});

test("unexpected bugs and SQL constraint violations are HTTP 500", () => {
  for (const error of [
    new TypeError("bug"),
    { code: "23514" },
    { code: "42702" },
  ]) {
    const response = responseFor(error);
    expect(response.status).toBe(500);
    expect(response.body).toEqual({ code: "INTERNAL_ERROR", retryable: false });
  }
});

for (const status of [400, 404, 429, 500, 503]) {
  test(`Nest HTTP ${status} preserves status and the existing retry contract`, () => {
    const response = responseFor(
      new HttpException("details must not leak", status),
    );
    expect(response.status).toBe(status);
    expect(response.body).toEqual({
      code: status === 400 ? "INVALID_PAYLOAD" : "HTTP_ERROR",
      retryable: status === 503,
    });
    expect(response.headers["Retry-After"]).toBe(
      status === 503 ? "1" : undefined,
    );
  });
}

test("HTTP infrastructure logs preserve identifiers without logging the financial payload", () => {
  const log = spyOn(telemetry, "log").mockImplementation(() => {});
  try {
    const response = responseFor(
      { code: "ECONNREFUSED" },
      {
        headers: { "x-correlation-id": "trace-123", authorization: "secret" },
        body: {
          walletId: "wallet-123",
          providerId: "provider-a",
          money: { amount: "999.00", currency: "BRL" },
        },
      },
    );
    expect(response.status).toBe(503);
    expect(response.headers["X-Correlation-Id"]).toBe("trace-123");
    expect(log).toHaveBeenCalledWith("http_infrastructure_error", {
      correlationId: "trace-123",
      walletId: "wallet-123",
      providerId: "provider-a",
      transactionId: undefined,
      errorCode: "ECONNREFUSED",
    });
    const serialized = JSON.stringify(log.mock.calls);
    expect(serialized).not.toContain("999.00");
    expect(serialized).not.toContain("secret");
  } finally {
    log.mockRestore();
  }
});
