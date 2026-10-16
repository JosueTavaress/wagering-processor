import { MoneyProps } from "../../domain/entity/Money";
import { InboxContext } from "../port/UnitOfWork";
export type ProcessWagerTransactionInput = {
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: "BET" | "WIN" | "LOSS" | "REFUND" | "ROLLBACK";
  money: MoneyProps;
  referenceExternalTransactionId?: string;
};
export type ProcessingContext = {
  correlationId: string;
  causationId?: string;
  inbox?: InboxContext;
  retryReference?: boolean;
};
