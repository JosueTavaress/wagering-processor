import type { LedgerDirection } from "./WalletLedgerEntry";
import { Money } from "./Money";
import { DomainError } from "./DomainError";
export type Kind = "OPENING" | "BET" | "WIN" | "LOSS" | "REFUND" | "ROLLBACK";
export type Status =
  | "PENDING"
  | "PENDING_REFERENCE"
  | "PROCESSED"
  | "REJECTED"
  | "FAILED";
export type TransactionState = {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: Kind;
  money: Money;
  referenceExternalTransactionId?: string;
  status: Status;
  referenceTransactionId?: string;
  failureCode?: string;
  processedAt?: Date;
  createdAt: Date;
  balance?: Money;
  attempts: number;
  nextAttemptAt: Date;
};
export class WagerTransaction {
  private constructor(private readonly state: TransactionState) {}
  static create(
    props: Omit<
      TransactionState,
      "status" | "createdAt" | "attempts" | "nextAttemptAt"
    >,
  ): WagerTransaction {
    if (
      ["BET", "LOSS"].includes(props.kind) &&
      props.referenceExternalTransactionId
    )
      throw new DomainError("UNEXPECTED_REFERENCE");
    if (props.referenceExternalTransactionId === props.externalTransactionId)
      throw new DomainError("INVALID_REFERENCE");
    if (
      ["REFUND", "ROLLBACK"].includes(props.kind) &&
      !props.referenceExternalTransactionId
    )
      throw new DomainError("REFERENCE_REQUIRED");
    if (
      props.kind === "LOSS" ? !props.money.isZero() : !props.money.isPositive()
    )
      throw new DomainError("INVALID_AMOUNT");
    return new WagerTransaction({
      ...props,
      status: "PENDING",
      createdAt: new Date(),
      attempts: 0,
      nextAttemptAt: new Date(),
    });
  }
  static rehydrate(state: TransactionState): WagerTransaction {
    return new WagerTransaction({
      ...state,
      createdAt: new Date(state.createdAt),
      processedAt: state.processedAt ? new Date(state.processedAt) : undefined,
      nextAttemptAt: new Date(state.nextAttemptAt),
    });
  }
  snapshot(): Readonly<TransactionState> {
    return {
      ...this.state,
      createdAt: new Date(this.state.createdAt),
      processedAt: this.state.processedAt
        ? new Date(this.state.processedAt)
        : undefined,
      nextAttemptAt: new Date(this.state.nextAttemptAt),
    };
  }
  get id() {
    return this.state.id;
  }
  get status() {
    return this.state.status;
  }
  get money() {
    return this.state.money;
  }
  get kind() {
    return this.state.kind;
  }
  get failureCode() {
    return this.state.failureCode;
  }
  get referenceTransactionId() {
    return this.state.referenceTransactionId;
  }
  isTerminal(): boolean {
    return ["PROCESSED", "REJECTED", "FAILED"].includes(this.status);
  }
  affectsBalance(): boolean {
    return this.kind !== "LOSS";
  }
  requiresReference(): boolean {
    return ["REFUND", "ROLLBACK"].includes(this.kind);
  }
  isReferenceRetryDue(now: Date): boolean {
    return (
      this.status === "PENDING_REFERENCE" && this.state.nextAttemptAt <= now
    );
  }
  matchesPayload(hash: string): boolean {
    return this.state.payloadHash === hash;
  }
  private assertMutable(): void {
    if (this.isTerminal()) throw new DomainError("INVALID_TRANSACTION_STATE");
  }
  markProcessed(
    referenceId: string | undefined,
    at: Date,
    balance: Money,
  ): void {
    this.assertMutable();
    Object.assign(this.state, {
      status: "PROCESSED",
      referenceTransactionId: referenceId,
      processedAt: new Date(at),
      balance,
    });
  }
  markPendingReference(balance: Money, now = new Date()): void {
    this.assertMutable();
    this.state.status = "PENDING_REFERENCE";
    this.state.balance = balance;
    this.state.attempts++;
    this.state.nextAttemptAt = new Date(
      now.getTime() + Math.min(60000, 1000 * 2 ** (this.state.attempts - 1)),
    );
  }
  reject(code: string, balance: Money): void {
    this.assertMutable();
    Object.assign(this.state, {
      status: "REJECTED",
      failureCode: code,
      processedAt: new Date(),
      balance,
    });
  }
  fail(code: string): void {
    this.assertMutable();
    Object.assign(this.state, {
      status: "FAILED",
      failureCode: code,
      processedAt: new Date(),
    });
  }
  ledgerDirectionFor(reference?: WagerTransaction): LedgerDirection {
    if (this.kind === "LOSS") throw new DomainError("NO_LEDGER_DIRECTION");
    if (this.kind === "ROLLBACK") {
      if (!reference) throw new DomainError("REFERENCE_REQUIRED");
      return reference.kind === "BET" ? "CREDIT" : "DEBIT";
    }
    return this.kind === "BET" ? "DEBIT" : "CREDIT";
  }
}
