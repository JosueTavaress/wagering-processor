import { TransactionKind } from "../../domain/entity/WagerTransaction";
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
  kind:
    | typeof TransactionKind.Bet
    | typeof TransactionKind.Win
    | typeof TransactionKind.Loss
    | typeof TransactionKind.Refund
    | typeof TransactionKind.Rollback;
  money: MoneyProps;
  referenceExternalTransactionId?: string;
};
export type ProcessingContext = {
  correlationId: string;
  causationId?: string;
  inbox?: InboxContext;
  retryReference?: boolean;
};
