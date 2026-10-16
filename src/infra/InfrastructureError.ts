export const PostgresErrorCode = {
  SerializationFailure: "40001",
  Deadlock: "40P01",
  LockNotAvailable: "55P03",
  QueryCanceled: "57014",
  AdminShutdown: "57P01",
  CrashShutdown: "57P02",
  CannotConnectNow: "57P03",
  InsufficientPrivilege: "42501",
  SyntaxError: "42601",
  CheckViolation: "23514",
  UniqueViolation: "23505",
} as const;
export const PostgresErrorClass = {
  Connection: "08",
  Resources: "53",
  Authentication: "28",
} as const;
export const FailureCategory = {
  Programming: "programming",
  Domain: "domain",
  InvalidMessage: "invalid-message",
  Permanent: "permanent",
  Transient: "transient",
  Unknown: "unknown",
} as const;
export const UnknownErrorCode = "UNKNOWN";
const transientCodes = new Set<string>([
  PostgresErrorCode.SerializationFailure,
  PostgresErrorCode.Deadlock,
  PostgresErrorCode.LockNotAvailable,
  PostgresErrorCode.QueryCanceled,
  PostgresErrorCode.AdminShutdown,
  PostgresErrorCode.CrashShutdown,
  PostgresErrorCode.CannotConnectNow,
  "ECONNREFUSED",
  "ECONNRESET",
  "ETIMEDOUT",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "EAI_AGAIN",
  "ENOTFOUND",
  "EPIPE",
]);
const transientNames = new Set([
  "TimeoutError",
  "RequestTimeout",
  "RequestTimeoutException",
  "ConnectionError",
  "ConnectionException",
  "ConnectionRefusedError",
  "KnexTimeoutError",
  "ServiceUnavailable",
  "ServiceUnavailableException",
]);

// Error causes can be cyclic; every classifier uses the same bounded-by-chain traversal.
export function* errorChain(
  error: unknown,
): Generator<Record<string, unknown>> {
  const visited = new Set<object>();
  while (typeof error === "object" && error !== null && !visited.has(error)) {
    visited.add(error);
    const current = error as Record<string, unknown>;
    yield current;
    error = current.cause;
  }
}

export function infrastructureErrorCode(error: unknown): string | undefined {
  for (const cause of errorChain(error)) {
    if (typeof cause.code === "string") return cause.code;
  }
  return undefined;
}

function serviceStatus(error: Record<string, unknown>): number | undefined {
  const metadata = error.$metadata;
  if (typeof metadata !== "object" || metadata === null) return undefined;
  if (
    "httpStatusCode" in metadata &&
    typeof metadata.httpStatusCode === "number"
  )
    return metadata.httpStatusCode;
  return undefined;
}

const permanentNames = new Set([
  "AccessDenied",
  "AccessDeniedException",
  "InvalidClientTokenId",
  "UnrecognizedClientException",
  "CredentialsProviderError",
]);

const permanentPostgresCodes: ReadonlySet<string> = new Set([
  PostgresErrorCode.InsufficientPrivilege,
  PostgresErrorCode.SyntaxError,
  PostgresErrorCode.CheckViolation,
]);
type InfrastructureFailure = {
  category: typeof FailureCategory.Permanent | typeof FailureCategory.Transient;
  errorCode: string;
};

export function classifyInfrastructureError(
  error: unknown,
): InfrastructureFailure | undefined {
  let transient: InfrastructureFailure | undefined;
  for (const cause of errorChain(error)) {
    const code = typeof cause.code === "string" ? cause.code : undefined;
    const name = typeof cause.name === "string" ? cause.name : undefined;
    const status = serviceStatus(cause);
    const errorCode = code ?? name ?? UnknownErrorCode;
    if (
      (code &&
        (code.startsWith(PostgresErrorClass.Authentication) ||
          permanentPostgresCodes.has(code))) ||
      (name && permanentNames.has(name)) ||
      status === 401 ||
      status === 403
    )
      return { category: FailureCategory.Permanent, errorCode };
    if (
      (code &&
        (transientCodes.has(code) ||
          code.startsWith(PostgresErrorClass.Connection) ||
          code.startsWith(PostgresErrorClass.Resources))) ||
      (name && transientNames.has(name)) ||
      (status !== undefined && (status === 429 || status >= 500))
    )
      transient ??= { category: FailureCategory.Transient, errorCode };
  }
  // A permanent cause takes precedence even when an outer wrapper looks transient.
  return transient;
}

export function isPermanentInfrastructureError(error: unknown): boolean {
  return (
    classifyInfrastructureError(error)?.category === FailureCategory.Permanent
  );
}

export function isTransientInfrastructureError(error: unknown): boolean {
  return (
    classifyInfrastructureError(error)?.category === FailureCategory.Transient
  );
}

export function infrastructureErrorName(error: unknown): string | undefined {
  let name: string | undefined;
  for (const cause of errorChain(error)) {
    if (typeof cause.name === "string") name = cause.name;
  }
  return name;
}
