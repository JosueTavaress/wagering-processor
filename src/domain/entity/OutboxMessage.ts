import { IntegrationEvent } from "../event/IntegrationEvent";
const RetryPolicy = {
  baseDelayMs: 1000,
  maxDelayMs: 60000,
  maxExponent: 6,
} as const;

export type OutboxState = {
  id: string;
  aggregateId: string;
  eventType: string;
  payload: Readonly<Record<string, unknown>>;
  occurredAt: Date;
  attempts: number;
  nextAttemptAt: Date;
  publishedAt?: Date;
};
export class OutboxMessage {
  private constructor(private readonly state: OutboxState) {}
  static enqueue(event: IntegrationEvent<unknown>) {
    return new OutboxMessage({
      id: event.eventId,
      aggregateId: event.aggregateId,
      eventType: event.eventType,
      payload: event.toJSON(),
      occurredAt: new Date(event.occurredAt),
      attempts: 0,
      nextAttemptAt: new Date(),
    });
  }
  static rehydrate(state: OutboxState) {
    return new OutboxMessage({
      ...state,
      occurredAt: new Date(state.occurredAt),
      nextAttemptAt: new Date(state.nextAttemptAt),
      publishedAt: state.publishedAt ? new Date(state.publishedAt) : undefined,
    });
  }
  snapshot() {
    return {
      ...this.state,
      occurredAt: new Date(this.state.occurredAt),
      nextAttemptAt: new Date(this.state.nextAttemptAt),
      publishedAt: this.state.publishedAt
        ? new Date(this.state.publishedAt)
        : undefined,
    };
  }
  isPending() {
    return !this.state.publishedAt;
  }
  isDue(now: Date) {
    return this.isPending() && this.state.nextAttemptAt <= now;
  }
  markPublished(at: Date) {
    this.state.publishedAt = new Date(at);
  }
  scheduleRetry(now: Date) {
    this.state.attempts++;
    this.state.nextAttemptAt = new Date(
      now.getTime() +
        Math.min(
          RetryPolicy.maxDelayMs,
          RetryPolicy.baseDelayMs *
            2 ** Math.min(this.state.attempts, RetryPolicy.maxExponent),
        ),
    );
  }
}
