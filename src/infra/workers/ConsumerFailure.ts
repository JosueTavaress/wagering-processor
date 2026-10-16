import { ZodError } from "zod";
import { DomainError } from "../../domain/entity/DomainError";
import {
  errorChain,
  infrastructureErrorCode,
  infrastructureErrorName,
  classifyInfrastructureError,
} from "../InfrastructureError";

export function classifyConsumerFailure(error: unknown) {
  const causes = [...errorChain(error)];
  const errorCode =
    infrastructureErrorCode(error) ??
    infrastructureErrorName(error) ??
    "UNKNOWN";
  // A recognized bug takes precedence over domain, payload and infrastructure errors.
  const programming = causes.find(
    (cause) =>
      (cause instanceof DomainError && cause.isProgrammingError()) ||
      cause instanceof TypeError ||
      cause instanceof ReferenceError ||
      cause instanceof RangeError,
  );
  if (programming) {
    const code =
      programming instanceof DomainError
        ? programming.code
        : String(programming.name);
    return {
      category: "programming",
      retryable: false,
      reason:
        programming instanceof DomainError
          ? programming.code
          : "PROGRAMMING_ERROR",
      errorCode: code,
    } as const;
  }
  const domain = causes.find((cause) => cause instanceof DomainError);
  if (domain instanceof DomainError)
    return {
      category: "domain",
      retryable: false,
      reason: domain.code,
      errorCode: domain.code,
    } as const;
  const invalid = causes.find(
    (cause) => cause instanceof ZodError || cause instanceof SyntaxError,
  );
  if (invalid)
    return {
      category: "invalid-message",
      retryable: false,
      reason: "INVALID_MESSAGE",
      errorCode: String(invalid.name),
    } as const;
  const infrastructure = classifyInfrastructureError(error);
  if (infrastructure?.category === "permanent")
    return {
      category: "permanent",
      retryable: false,
      reason: "PERMANENT_INFRASTRUCTURE_ERROR",
      errorCode: infrastructure.errorCode,
    } as const;
  if (infrastructure?.category === "transient")
    return {
      category: "transient",
      retryable: true,
      reason: "INFRASTRUCTURE_RETRIES_EXHAUSTED",
      errorCode: infrastructure.errorCode,
    } as const;
  return {
    category: "unknown",
    retryable: true,
    reason: "UNKNOWN_FAILURE_RETRIES_EXHAUSTED",
    errorCode,
  } as const;
}
