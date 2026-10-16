CREATE OR REPLACE FUNCTION validate_ledger() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
 t wager_transactions;
 reference_kind text;
 expected_direction text;
 previous_balance numeric;
BEGIN
 -- Serialize ledger appends even when a writer bypasses the application.
 PERFORM 1 FROM wallets WHERE id=NEW.wallet_id FOR UPDATE;
 SELECT * INTO t FROM wager_transactions WHERE id=NEW.transaction_id;
 IF t.id IS NULL OR t.status<>'PROCESSED' OR t.kind='LOSS'
    OR t.wallet_id<>NEW.wallet_id OR t.amount<>NEW.amount OR t.currency<>NEW.currency THEN
   RAISE EXCEPTION 'invalid ledger transaction' USING ERRCODE='23514';
 END IF;
 IF t.kind='ROLLBACK' THEN
   SELECT kind INTO reference_kind FROM wager_transactions WHERE id=t.reference_transaction_id AND status='PROCESSED';
   IF reference_kind IS NULL OR reference_kind NOT IN ('BET','WIN','REFUND') THEN
     RAISE EXCEPTION 'invalid rollback reference' USING ERRCODE='23514';
   END IF;
   expected_direction:=CASE WHEN reference_kind='BET' THEN 'CREDIT' ELSE 'DEBIT' END;
 ELSE
   expected_direction:=CASE WHEN t.kind='BET' THEN 'DEBIT' ELSE 'CREDIT' END;
 END IF;
 IF NEW.direction<>expected_direction THEN
   RAISE EXCEPTION 'invalid ledger direction' USING ERRCODE='23514';
 END IF;
 SELECT balance_after INTO previous_balance FROM wallet_ledger
 WHERE wallet_id=NEW.wallet_id ORDER BY sequence DESC LIMIT 1;
 IF NEW.balance_before<>coalesce(previous_balance,0) THEN
   RAISE EXCEPTION 'discontinuous ledger balance' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
