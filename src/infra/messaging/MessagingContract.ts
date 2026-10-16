export const QueueName = {
  Transactions: "wager-transactions.fifo",
  DeadLetters: "wager-transactions-dlq.fifo",
  Events: "wager-events.fifo",
} as const;
export const MessageType = {
  WagerTransactionRequested: "WagerTransactionRequested",
} as const;
export const WagerConsumerName = "wager-v1";
export const DeadLetterMessageGroup = "dead-letter";
