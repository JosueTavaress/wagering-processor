export const FailureCode = {
  InvalidTransactionState: "INVALID_TRANSACTION_STATE",
  UnbalancedLedger: "UNBALANCED_LEDGER",
  NoLedgerDirection: "NO_LEDGER_DIRECTION",
  InboxAlreadyProcessed: "INBOX_ALREADY_PROCESSED",
  InvalidMoney: "INVALID_MONEY",
  CurrencyMismatch: "CURRENCY_MISMATCH",
  InvalidAmount: "INVALID_AMOUNT",
  InvalidInitialBalance: "INVALID_INITIAL_BALANCE",
  ReferenceRequired: "REFERENCE_REQUIRED",
  UnexpectedReference: "UNEXPECTED_REFERENCE",
  InvalidReference: "INVALID_REFERENCE",
  PlayerMismatch: "PLAYER_MISMATCH",
  ReferenceNotProcessed: "REFERENCE_NOT_PROCESSED",
  InvalidReferenceKind: "INVALID_REFERENCE_KIND",
  ReferenceAmountMismatch: "REFERENCE_AMOUNT_MISMATCH",
  ReferenceMismatch: "REFERENCE_MISMATCH",
  ReversalInsufficientFunds: "REVERSAL_INSUFFICIENT_FUNDS",
  InsufficientFunds: "INSUFFICIENT_FUNDS",
  IdempotencyConflict: "IDEMPOTENCY_CONFLICT",
  AlreadyReversed: "ALREADY_REVERSED",
  ReferenceExpired: "REFERENCE_EXPIRED",
  WalletNotFound: "WALLET_NOT_FOUND",
  InboxConflict: "INBOX_CONFLICT",
  UniquenessConflict: "UNIQUENESS_CONFLICT",
  InvalidCursor: "INVALID_CURSOR",
  TransactionNotFound: "TRANSACTION_NOT_FOUND",
  MoneyMustBeString: "MONEY_MUST_BE_STRING",
} as const;
const programmingErrors = new Set<string>([
  FailureCode.InvalidTransactionState,
  FailureCode.UnbalancedLedger,
  FailureCode.NoLedgerDirection,
  FailureCode.InboxAlreadyProcessed,
]);

export class DomainError extends Error {
  constructor(public readonly code: string) {
    super(code);
    this.name = "DomainError";
  }

  isProgrammingError(): boolean {
    return programmingErrors.has(this.code);
  }
}
