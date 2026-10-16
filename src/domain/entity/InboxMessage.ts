import { DomainError } from "./DomainError";
export type InboxState = {
  messageId: string;
  consumerName: string;
  payloadHash: string;
  receivedAt: Date;
  processedAt?: Date;
};
export class InboxMessage {
  private constructor(private readonly state: InboxState) {}
  static receive(props: Omit<InboxState, "receivedAt" | "processedAt">) {
    return new InboxMessage({ ...props, receivedAt: new Date() });
  }
  static rehydrate(state: InboxState) {
    return new InboxMessage({
      ...state,
      receivedAt: new Date(state.receivedAt),
      processedAt: state.processedAt ? new Date(state.processedAt) : undefined,
    });
  }
  get processedAt() {
    return this.state.processedAt
      ? new Date(this.state.processedAt)
      : undefined;
  }
  isProcessed() {
    return !!this.state.processedAt;
  }
  markProcessed(at: Date) {
    if (this.isProcessed()) throw new DomainError("INBOX_ALREADY_PROCESSED");
    this.state.processedAt = new Date(at);
  }
  snapshot() {
    return {
      ...this.state,
      receivedAt: new Date(this.state.receivedAt),
      processedAt: this.processedAt,
    };
  }
}
