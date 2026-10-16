import { ZodError } from "zod";
import { DomainError } from "../../domain/entity/DomainError";
import {
  errorChain,
  infrastructureErrorCode,
  infrastructureErrorName,
  classifyInfrastructureError,
  UnknownErrorCode,
  FailureCategory,
} from "../InfrastructureError";
export const ConsumerFailureReason = {
  Programming: "PROGRAMMING_ERROR",
  InvalidMessage: "INVALID_MESSAGE",
  PermanentInfrastructure: "PERMANENT_INFRASTRUCTURE_ERROR",
  InfrastructureRetriesExhausted: "INFRASTRUCTURE_RETRIES_EXHAUSTED",
  UnknownRetriesExhausted: "UNKNOWN_FAILURE_RETRIES_EXHAUSTED",
} as const;

export function classifyConsumerFailure(error: unknown) {
  const causes = [...errorChain(error)];
  const errorCode =
    infrastructureErrorCode(error) ??
    infrastructureErrorName(error) ??
    UnknownErrorCode;
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
      category: FailureCategory.Programming,
      retryable: false,
      reason:
        programming instanceof DomainError
          ? programming.code
          : ConsumerFailureReason.Programming,
      errorCode: code,
    } as const;
  }
  const domain = causes.find((cause) => cause instanceof DomainError);
  if (domain instanceof DomainError)
    return {
      category: FailureCategory.Domain,
      retryable: false,
      reason: domain.code,
      errorCode: domain.code,
    } as const;
  const invalid = causes.find(
    (cause) => cause instanceof ZodError || cause instanceof SyntaxError,
  );
  if (invalid)
    return {
      category: FailureCategory.InvalidMessage,
      retryable: false,
      reason: ConsumerFailureReason.InvalidMessage,
      errorCode: String(invalid.name),
    } as const;
  const infrastructure = classifyInfrastructureError(error);
  if (infrastructure?.category === FailureCategory.Permanent)
    return {
      category: FailureCategory.Permanent,
      retryable: false,
      reason: ConsumerFailureReason.PermanentInfrastructure,
      errorCode: infrastructure.errorCode,
    } as const;
  if (infrastructure?.category === FailureCategory.Transient)
    return {
      category: FailureCategory.Transient,
      retryable: true,
      reason: ConsumerFailureReason.InfrastructureRetriesExhausted,
      errorCode: infrastructure.errorCode,
    } as const;
  return {
    category: FailureCategory.Unknown,
    retryable: true,
    reason: ConsumerFailureReason.UnknownRetriesExhausted,
    errorCode,
  } as const;
}
