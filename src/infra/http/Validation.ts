import { HttpErrorCode } from "./HttpContract";
import { Currency, ZeroAmount } from "../../domain/entity/Money";
import {
  InternalProviderId,
  TransactionKind,
  ReversalKinds,
  NonReferencingKinds,
} from "../../domain/entity/WagerTransaction";
import { FailureCode } from "../../domain/entity/DomainError";
import { MessageType } from "../messaging/MessagingContract";
import { z } from "zod";
export const moneySchema = z
  .object({
    amount: z.string().regex(/^(0|[1-9]\d{0,15})\.\d{2}$/),
    currency: z.literal(Currency.BRL),
  })
  .strict();
const identifier = z.string().min(1).max(200);
export const commandSchema = z
  .object({
    providerId: identifier.refine((v) => v !== InternalProviderId),
    externalTransactionId: identifier,
    idempotencyKey: identifier,
    walletId: z.string().uuid(),
    playerId: z.string().uuid(),
    roundId: identifier,
    gameId: identifier,
    kind: z.enum([
      TransactionKind.Bet,
      TransactionKind.Win,
      TransactionKind.Loss,
      TransactionKind.Refund,
      TransactionKind.Rollback,
    ]),
    money: moneySchema,
    referenceExternalTransactionId: identifier.optional(),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (ReversalKinds.includes(v.kind) && !v.referenceExternalTransactionId)
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: FailureCode.ReferenceRequired,
      });
    if (v.referenceExternalTransactionId === v.externalTransactionId)
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: HttpErrorCode.SelfReference,
      });
    if (
      v.kind === TransactionKind.Loss
        ? v.money.amount !== ZeroAmount
        : v.money.amount === ZeroAmount
    )
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: FailureCode.InvalidAmount,
      });
    if (
      NonReferencingKinds.includes(v.kind) &&
      v.referenceExternalTransactionId
    )
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: FailureCode.UnexpectedReference,
      });
  });
export const openWalletSchema = z
  .object({ playerId: z.string().uuid(), initialBalance: moneySchema })
  .strict();
export const messageSchema = z
  .object({
    messageId: identifier,
    type: z.literal(MessageType.WagerTransactionRequested),
    occurredAt: z.string().datetime(),
    data: commandSchema,
  })
  .strict();
export const uuid = (value: string) => z.string().uuid().parse(value);
