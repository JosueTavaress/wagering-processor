import { DefaultApiUrl, HttpMethod } from "../src/infra/http/HttpContract";
import { Currency } from "../src/domain/entity/Money";
import { TransactionKind } from "../src/domain/entity/WagerTransaction";
import { randomUUID } from "node:crypto";
const base = process.env.API_URL ?? DefaultApiUrl;
const response = await fetch(base + "/wallets", {
  method: HttpMethod.Post,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    playerId: randomUUID(),
    initialBalance: { amount: "100.00", currency: Currency.BRL },
  }),
});
if (!response.ok) throw new Error("Wallet creation failed");
const wallet = (await response.json()) as { id: string; playerId: string };
const results = await Promise.all(
  [1, 2].map(async (n) => {
    const external = randomUUID();
    const r = await fetch(base + "/wagering/transactions", {
      method: HttpMethod.Post,
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": external,
      },
      body: JSON.stringify({
        providerId: "demo",
        externalTransactionId: external,
        walletId: wallet.id,
        playerId: wallet.playerId,
        roundId: "demo",
        gameId: "game",
        kind: TransactionKind.Bet,
        money: { amount: "80.00", currency: Currency.BRL },
      }),
    });
    return { request: n, http: r.status, result: await r.json() };
  }),
);
console.log(JSON.stringify(results, null, 2));
console.log(
  "Reconciliation",
  await (
    await fetch(base + `/wallets/${wallet.id}/reconciliation`, {
      method: HttpMethod.Post,
    })
  ).json(),
);
