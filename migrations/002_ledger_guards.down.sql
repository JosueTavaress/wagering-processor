CREATE OR REPLACE FUNCTION validate_ledger() RETURNS trigger LANGUAGE plpgsql AS $$ DECLARE t wager_transactions; BEGIN
 SELECT * INTO t FROM wager_transactions WHERE id=NEW.transaction_id;
 IF t.status<>'PROCESSED' OR t.kind='LOSS' OR t.wallet_id<>NEW.wallet_id OR t.amount<>NEW.amount OR t.currency<>NEW.currency THEN
 RAISE EXCEPTION 'invalid ledger transaction' USING ERRCODE='23514'; END IF; RETURN NEW;
END $$;
