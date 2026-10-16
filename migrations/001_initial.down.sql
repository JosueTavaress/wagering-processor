DROP TABLE failed_messages, outbox, inbox, wallet_ledger, wager_transactions, wallets CASCADE;
DROP FUNCTION reconcile_constraint(),validate_ledger(),terminal_transaction(),immutable_ledger();
DROP FUNCTION wallet_version_guard(),transaction_ledger_guard();
