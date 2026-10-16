import { z } from "zod";
export const moneySchema = z
  .object({
    amount: z.string().regex(/^(0|[1-9]\d{0,15})\.\d{2}$/),
    currency: z.literal("BRL"),
  })
  .strict();
const identifier = z.string().min(1).max(200);
export const commandSchema = z
  .object({
    providerId: identifier.refine((v) => v !== "__internal__"),
    externalTransactionId: identifier,
    idempotencyKey: identifier,
    walletId: z.string().uuid(),
    playerId: z.string().uuid(),
    roundId: identifier,
    gameId: identifier,
    kind: z.enum(["BET", "WIN", "LOSS", "REFUND", "ROLLBACK"]),
    money: moneySchema,
    referenceExternalTransactionId: identifier.optional(),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (
      ["REFUND", "ROLLBACK"].includes(v.kind) &&
      !v.referenceExternalTransactionId
    )
      ctx.addIssue({ code: "custom", message: "REFERENCE_REQUIRED" });
    if (v.referenceExternalTransactionId === v.externalTransactionId)
      ctx.addIssue({ code: "custom", message: "SELF_REFERENCE" });
    if (
      v.kind === "LOSS" ? v.money.amount !== "0.00" : v.money.amount === "0.00"
    )
      ctx.addIssue({ code: "custom", message: "INVALID_AMOUNT" });
    if (["BET", "LOSS"].includes(v.kind) && v.referenceExternalTransactionId)
      ctx.addIssue({ code: "custom", message: "UNEXPECTED_REFERENCE" });
  });
export const openWalletSchema = z
  .object({ playerId: z.string().uuid(), initialBalance: moneySchema })
  .strict();
export const messageSchema = z
  .object({
    messageId: identifier,
    type: z.literal("WagerTransactionRequested"),
    occurredAt: z.string().datetime(),
    data: commandSchema,
  })
  .strict();
export const uuid = (value: string) => z.string().uuid().parse(value);
