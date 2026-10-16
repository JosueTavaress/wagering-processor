export const IdentifierMaxLength = 200;
export const LedgerPagination = { defaultLimit: 50, maxLimit: 100 } as const;

export const HttpMethod = {
  Post: "POST",
} as const;
export const HealthStatus = {
  Up: "up",
  Ready: "ready",
  NotReady: "not_ready",
  Stopping: "stopping",
} as const;
export const DefaultApiUrl = "http://localhost:3000";
export const HttpHeader = {
  IdempotencyKey: "idempotency-key",
  Authorization: "authorization",
  CorrelationId: "x-correlation-id",
  CorrelationResponseId: "X-Correlation-Id",
  RetryAfter: "Retry-After",
} as const;
export const HttpErrorCode = {
  InvalidPayload: "INVALID_PAYLOAD",
  HttpError: "HTTP_ERROR",
  InfrastructureUnavailable: "INFRASTRUCTURE_UNAVAILABLE",
  InternalError: "INTERNAL_ERROR",
  SelfReference: "SELF_REFERENCE",
} as const;
