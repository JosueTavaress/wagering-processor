import {
  Catch,
  ExceptionFilter,
  ArgumentsHost,
  HttpException,
} from "@nestjs/common";
import type { Request, Response } from "express";
import { randomUUID } from "node:crypto";
import { ZodError } from "zod";
import { DomainError } from "../../domain/entity/DomainError";
import {
  infrastructureErrorCode,
  isTransientInfrastructureError,
} from "../InfrastructureError";
import { telemetry } from "../observability/Telemetry";

const domainHttpStatus: Readonly<Record<string, number>> = {
  WALLET_NOT_FOUND: 404,
  TRANSACTION_NOT_FOUND: 404,
  IDEMPOTENCY_CONFLICT: 409,
  UNIQUENESS_CONFLICT: 409,
  INBOX_CONFLICT: 409,
  INVALID_CURSOR: 400,
};

type HttpFailure = { status: number; code: string };

function classifyHttpError(error: unknown): HttpFailure {
  if (error instanceof ZodError)
    return { status: 400, code: "INVALID_PAYLOAD" };

  if (error instanceof DomainError)
    return {
      status: error.isProgrammingError()
        ? 500
        : (domainHttpStatus[error.code] ?? 422),
      code: error.code,
    };

  if (error instanceof HttpException)
    return {
      status: error.getStatus(),
      code: error.getStatus() === 400 ? "INVALID_PAYLOAD" : "HTTP_ERROR",
    };

  return isTransientInfrastructureError(error)
    ? { status: 503, code: "INFRASTRUCTURE_UNAVAILABLE" }
    : { status: 500, code: "INTERNAL_ERROR" };
}

function identifier(value: unknown): string | undefined {
  return typeof value === "string" ? value.slice(0, 200) : undefined;
}

function requestIdentifiers(request: Request, response: Response) {
  const body = request.body as Record<string, unknown> | undefined;
  return {
    correlationId:
      identifier(response.locals?.correlationId) ??
      identifier(request.headers?.["x-correlation-id"]) ??
      randomUUID(),
    walletId:
      identifier(body?.walletId) ?? identifier(request.params?.walletId),
    providerId:
      identifier(body?.providerId) ?? identifier(request.params?.providerId),
    transactionId:
      identifier(response.locals?.transactionId) ??
      identifier(request.params?.transactionId),
  };
}

@Catch()
export class ApiExceptionFilter implements ExceptionFilter {
  catch(error: unknown, host: ArgumentsHost) {
    const http = host.switchToHttp();
    const response = http.getResponse<Response>();
    const identifiers = requestIdentifiers(
      http.getRequest<Request>(),
      response,
    );
    response.setHeader("X-Correlation-Id", identifiers.correlationId);
    const { status, code } = classifyHttpError(error);

    if (status >= 500) {
      telemetry.log(
        status === 503 ? "http_infrastructure_error" : "http_internal_error",
        {
          ...identifiers,
          errorCode:
            infrastructureErrorCode(error) ??
            (error instanceof Error ? error.name : "UNKNOWN"),
        },
      );
    }
    if (status === 503) response.setHeader("Retry-After", "1");
    response.status(status).json({ code, retryable: status === 503 });
  }
}
