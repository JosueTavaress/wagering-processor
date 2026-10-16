import "reflect-metadata";
import { test, expect } from "bun:test";
import { Module } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { ApiController } from "../../src/infra/http/ApiController";
import { ApplicationToken } from "../../src/infra/composition";

// Exercise Bun's decorator metadata and Nest injection without replacing financial tests.
test("HTTP module initializes and injects the application under Bun", async () => {
  const walletId = "0192f291-27dd-7d3f-8071-5f8685deef37";
  const result = {
    id: walletId,
    playerId: "player",
    balance: { amount: "100.00", currency: "BRL" },
    version: 1,
  };
  const requestedWallets: string[] = [];
  const application = {
    getWallet: {
      execute: async ({ walletId }: { walletId: string }) => {
        requestedWallets.push(walletId);
        return result;
      },
    },
  };
  @Module({
    controllers: [ApiController],
    providers: [{ provide: ApplicationToken, useValue: application }],
  })
  class HttpTestModule {}
  const app = await NestFactory.create(HttpTestModule, {
    logger: false,
    abortOnError: false,
  });
  try {
    await app.init();
    const controller = app.get(ApiController);
    expect(controller.live()).toEqual({ status: "up" });
    expect(await controller.wallet(walletId)).toEqual(result);
    expect(requestedWallets).toEqual([walletId]);
  } finally {
    await app.close();
  }
});
