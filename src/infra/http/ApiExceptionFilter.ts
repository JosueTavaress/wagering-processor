import { HttpErrorCode, HttpHeader } from "./HttpContract";
import {
  Catch,
  ExceptionFilter,
  ArgumentsHost,
  HttpException,
} from "@nestjs/common";
import { type Request, type Response } from "express";
import { randomUUID } from "node:crypto";
import { ZodError } from "zod";
import { DomainError, FailureCode } from "../../domain/entity/DomainError";
import {
  infrastructureErrorCode,
  isTransientInfrastructureError,
  UnknownErrorCode,
} from "../InfrastructureError";
import { telemetry, LogEvent } from "../observability/Telemetry";
const domainHttpStatus: Readonly<Record<string, number>> = {
  [FailureCode.WalletNotFound]: 404,
  [FailureCode.TransactionNotFound]: 404,
  [FailureCode.IdempotencyConflict]: 409,
  [FailureCode.UniquenessConflict]: 409,
  [FailureCode.InboxConflict]: 409,
  [FailureCode.InvalidCursor]: 400,
};

type HttpFailure = { status: number; code: string };

function classifyHttpError(error: unknown): HttpFailure {
  if (error instanceof ZodError)
    return { status: 400, code: HttpErrorCode.InvalidPayload };

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
      code:
        error.getStatus() === 400
          ? HttpErrorCode.InvalidPayload
          : HttpErrorCode.HttpError,
    };

  return isTransientInfrastructureError(error)
    ? { status: 503, code: HttpErrorCode.InfrastructureUnavailable }
    : { status: 500, code: HttpErrorCode.InternalError };
}

function identifier(value: unknown): string | undefined {
  return typeof value === "string" ? value.slice(0, 200) : undefined;
}

function requestIdentifiers(request: Request, response: Response) {
  const body = request.body as Record<string, unknown> | undefined;
  return {
    correlationId:
      identifier(response.locals?.correlationId) ??
      identifier(request.headers?.[HttpHeader.CorrelationId]) ??
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
    response.setHeader(
      HttpHeader.CorrelationResponseId,
      identifiers.correlationId,
    );
    const { status, code } = classifyHttpError(error);

    if (status >= 500) {
      telemetry.log(
        status === 503
          ? LogEvent.HttpInfrastructureError
          : LogEvent.HttpInternalError,
        {
          ...identifiers,
          errorCode:
            infrastructureErrorCode(error) ??
            (error instanceof Error ? error.name : UnknownErrorCode),
        },
      );
    }
    if (status === 503) response.setHeader(HttpHeader.RetryAfter, "1");
    response.status(status).json({ code, retryable: status === 503 });
  }
}
