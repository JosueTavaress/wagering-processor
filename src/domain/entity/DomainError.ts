const programmingErrors = new Set([
  "INVALID_TRANSACTION_STATE",
  "UNBALANCED_LEDGER",
  "NO_LEDGER_DIRECTION",
  "INBOX_ALREADY_PROCESSED",
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
