import { randomUUID } from "node:crypto";
import { commandSchema } from "../src/infra/http/Validation";
import { SqsBroker } from "../src/infra/messaging/SqsBroker";
const path = process.argv[2];
if (!path) throw new Error("Usage: bun scripts/send.ts command.json");
const input = commandSchema.parse(await Bun.file(path).json());
const broker = new SqsBroker();
try {
  const messageId = process.env.MESSAGE_ID ?? randomUUID();
  await broker.publish(
    JSON.stringify({
      messageId,
      type: "WagerTransactionRequested",
      occurredAt: new Date().toISOString(),
      data: input,
    }),
    input.walletId,
    randomUUID(),
    "wager-transactions.fifo",
  );
  console.log(
    JSON.stringify({
      messageId,
      walletId: input.walletId,
      externalTransactionId: input.externalTransactionId,
    }),
  );
} finally {
  broker.close();
}
