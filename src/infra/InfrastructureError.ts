const transientCodes = new Set([
  "40001",
  "40P01",
  "55P03",
  "57014",
  "57P01",
  "57P02",
  "57P03",
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

type InfrastructureFailure = {
  category: "permanent" | "transient";
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
    const errorCode = code ?? name ?? "UNKNOWN";
    if (
      (code &&
        (code.startsWith("28") ||
          ["42501", "42601", "23514"].includes(code))) ||
      (name && permanentNames.has(name)) ||
      status === 401 ||
      status === 403
    )
      return { category: "permanent", errorCode };
    if (
      (code &&
        (transientCodes.has(code) ||
          code.startsWith("08") ||
          code.startsWith("53"))) ||
      (name && transientNames.has(name)) ||
      (status !== undefined && (status === 429 || status >= 500))
    )
      transient ??= { category: "transient", errorCode };
  }
  // A permanent cause takes precedence even when an outer wrapper looks transient.
  return transient;
}

export function isPermanentInfrastructureError(error: unknown): boolean {
  return classifyInfrastructureError(error)?.category === "permanent";
}

export function isTransientInfrastructureError(error: unknown): boolean {
  return classifyInfrastructureError(error)?.category === "transient";
}

export function infrastructureErrorName(error: unknown): string | undefined {
  let name: string | undefined;
  for (const cause of errorChain(error)) {
    if (typeof cause.name === "string") name = cause.name;
  }
  return name;
}
