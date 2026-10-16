import { TransactionStatus } from "../../domain/entity/WagerTransaction";
import {
  IdentifierMaxLength,
  LedgerPagination,
  HttpHeader,
  HealthStatus,
} from "./HttpContract";
import {
  HttpStatus,
  Controller,
  Get,
  Post,
  Body,
  Param,
  Query,
  Headers,
  Res,
  Inject,
} from "@nestjs/common";
import { type Response } from "express";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { type ProcessWagerTransactionOutput } from "../../application/process-wager-transaction/ProcessWagerTransactionOutput";
import type { Application } from "../composition";
import { ApplicationToken } from "../composition";
import { commandSchema, openWalletSchema, uuid } from "./Validation";
import { telemetry, LogEvent } from "../observability/Telemetry";
const wagerHttpStatus = {
  [TransactionStatus.Processed]: HttpStatus.OK,
  [TransactionStatus.Pending]: HttpStatus.ACCEPTED,
  [TransactionStatus.PendingReference]: HttpStatus.ACCEPTED,
  [TransactionStatus.Rejected]: HttpStatus.UNPROCESSABLE_ENTITY,
  [TransactionStatus.Failed]: HttpStatus.INTERNAL_SERVER_ERROR,
} satisfies Record<ProcessWagerTransactionOutput["status"], number>;

@Controller()
export class ApiController {
  constructor(@Inject(ApplicationToken) private readonly app: Application) {}
  @Post("wallets") async open(@Body() body: unknown) {
    return this.app.open.execute(openWalletSchema.parse(body));
  }
  @Get("wallets/:walletId") async wallet(@Param("walletId") id: string) {
    return this.app.getWallet.execute({ walletId: uuid(id) });
  }
  @Get("wallets/:walletId/ledger") async ledger(
    @Param("walletId") id: string,
    @Query("cursor") cursor?: string,
    @Query("limit") rawLimit?: string,
  ) {
    const limit = z.coerce
      .number()
      .int()
      .min(1)
      .max(LedgerPagination.maxLimit)
      .parse(rawLimit ?? LedgerPagination.defaultLimit);
    return this.app.getLedger.execute({ walletId: uuid(id), cursor, limit });
  }
  @Get("wagering/transactions/:transactionId") async transaction(
    @Param("transactionId") id: string,
  ) {
    return this.app.getTransaction.execute({ transactionId: uuid(id) });
  }
  @Get("providers/:providerId/wagering/transactions/:externalTransactionId")
  async providerTransaction(
    @Param("providerId") providerId: string,
    @Param("externalTransactionId") externalTransactionId: string,
  ) {
    return this.app.getProviderTransaction.execute({
      providerId,
      externalTransactionId,
    });
  }
  @Post("wagering/transactions") async wager(
    @Body() body: unknown,
    @Headers(HttpHeader.IdempotencyKey) key: string | undefined,
    @Headers(HttpHeader.Authorization) authorization: string | undefined,
    @Headers(HttpHeader.CorrelationId) correlation: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ) {
    const input = commandSchema.parse({
      ...z.record(z.unknown()).parse(body),
      idempotencyKey: key,
    });
    const correlationId =
      correlation?.slice(0, IdentifierMaxLength) || randomUUID();
    res.locals.correlationId = correlationId;
    await this.app.identity.assertProvider(input.providerId, authorization);
    const stop = telemetry.latency.startTimer();
    try {
      const result = await this.app.process.execute(input, { correlationId });
      res.locals.transactionId = result.transactionId;
      res.status(wagerHttpStatus[result.status]);
      res.setHeader(HttpHeader.CorrelationResponseId, correlationId);
      if (result.idempotentReplay) telemetry.duplicates.inc();
      else telemetry.transactions.inc({ status: result.status });
      telemetry.log(LogEvent.WagerHttp, {
        correlationId,
        transactionId: result.transactionId,
        walletId: input.walletId,
        providerId: input.providerId,
        status: result.status,
        idempotentReplay: result.idempotentReplay,
      });
      return result;
    } finally {
      stop();
    }
  }
  @Post("wallets/:walletId/reconciliation") async reconcile(
    @Param("walletId") id: string,
    @Res({ passthrough: true }) res: Response,
  ) {
    res.status(HttpStatus.OK);
    return this.app.reconcile.execute({ walletId: uuid(id) });
  }
  @Get("health/live") live() {
    return { status: HealthStatus.Up };
  }
  @Get("health/ready") async ready(@Res({ passthrough: true }) res: Response) {
    try {
      await this.app.db.em.fork().execute("select 1");
      await this.app.broker.ready();
      return { status: HealthStatus.Ready };
    } catch {
      res.status(HttpStatus.SERVICE_UNAVAILABLE);
      return { status: HealthStatus.NotReady };
    }
  }
  @Get("metrics") async metrics(@Res() res: Response) {
    res.setHeader("Content-Type", telemetry.registry.contentType);
    res.send(await telemetry.registry.metrics());
  }
}
