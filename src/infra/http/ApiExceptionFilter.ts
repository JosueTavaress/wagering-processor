import { IdentifierMaxLength, HttpErrorCode, HttpHeader } from "./HttpContract";
import {
  HttpStatus,
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
  [FailureCode.WalletNotFound]: HttpStatus.NOT_FOUND,
  [FailureCode.TransactionNotFound]: HttpStatus.NOT_FOUND,
  [FailureCode.IdempotencyConflict]: HttpStatus.CONFLICT,
  [FailureCode.UniquenessConflict]: HttpStatus.CONFLICT,
  [FailureCode.InboxConflict]: HttpStatus.CONFLICT,
  [FailureCode.InvalidCursor]: HttpStatus.BAD_REQUEST,
};

type HttpFailure = { status: number; code: string };

function classifyHttpError(error: unknown): HttpFailure {
  if (error instanceof ZodError)
    return {
      status: HttpStatus.BAD_REQUEST,
      code: HttpErrorCode.InvalidPayload,
    };

  if (error instanceof DomainError)
    return {
      status: error.isProgrammingError()
        ? HttpStatus.INTERNAL_SERVER_ERROR
        : (domainHttpStatus[error.code] ?? HttpStatus.UNPROCESSABLE_ENTITY),
      code: error.code,
    };

  if (error instanceof HttpException)
    return {
      status: error.getStatus(),
      code:
        error.getStatus() === HttpStatus.BAD_REQUEST
          ? HttpErrorCode.InvalidPayload
          : HttpErrorCode.HttpError,
    };

  return isTransientInfrastructureError(error)
    ? {
        status: HttpStatus.SERVICE_UNAVAILABLE,
        code: HttpErrorCode.InfrastructureUnavailable,
      }
    : {
        status: HttpStatus.INTERNAL_SERVER_ERROR,
        code: HttpErrorCode.InternalError,
      };
}

function identifier(value: unknown): string | undefined {
  return typeof value === "string"
    ? value.slice(0, IdentifierMaxLength)
    : undefined;
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

    if (status >= HttpStatus.INTERNAL_SERVER_ERROR) {
      telemetry.log(
        status === HttpStatus.SERVICE_UNAVAILABLE
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
    if (status === HttpStatus.SERVICE_UNAVAILABLE)
      response.setHeader(HttpHeader.RetryAfter, "1");
    response
      .status(status)
      .json({ code, retryable: status === HttpStatus.SERVICE_UNAVAILABLE });
  }
}
