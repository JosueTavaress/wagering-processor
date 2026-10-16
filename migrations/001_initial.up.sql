CREATE TABLE wallets (
 id uuid PRIMARY KEY, player_id uuid NOT NULL, currency char(3) NOT NULL CHECK(currency ~ '^[A-Z]{3}$'),
 balance numeric NOT NULL CHECK(balance>=0 AND balance<'Infinity'::numeric AND scale(balance)<=2), version integer NOT NULL CHECK(version>=1),
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), UNIQUE(player_id,currency), UNIQUE(id,currency)
);
CREATE TABLE wager_transactions (
 id uuid PRIMARY KEY, provider_id text NOT NULL, external_transaction_id text NOT NULL, idempotency_key text NOT NULL UNIQUE,
 payload_hash text NOT NULL, wallet_id uuid NOT NULL REFERENCES wallets(id), player_id uuid NOT NULL,
 round_id text NOT NULL, game_id text NOT NULL, kind text NOT NULL CHECK(kind IN ('OPENING','BET','WIN','LOSS','REFUND','ROLLBACK')),
 amount numeric NOT NULL CHECK(amount>=0 AND amount<'Infinity'::numeric AND scale(amount)<=2), currency char(3) NOT NULL,
 reference_external_transaction_id text, reference_transaction_id uuid REFERENCES wager_transactions(id),
 status text NOT NULL CHECK(status IN ('PENDING','PENDING_REFERENCE','PROCESSED','REJECTED','FAILED')),
 failure_code text, balance numeric CHECK(balance>=0 AND balance<'Infinity'::numeric AND scale(balance)<=2),
 balance_currency char(3), CHECK ((balance IS NULL)=(balance_currency IS NULL)),
 created_at timestamptz NOT NULL DEFAULT now(), processed_at timestamptz, attempts integer NOT NULL DEFAULT 0,
 next_attempt_at timestamptz NOT NULL DEFAULT now(), UNIQUE(provider_id,external_transaction_id),
 CHECK ((kind='LOSS' AND amount=0) OR (kind<>'LOSS' AND amount>0)),
 CHECK (kind NOT IN ('REFUND','ROLLBACK') OR reference_external_transaction_id IS NOT NULL),
 CHECK (status NOT IN ('REJECTED','FAILED') OR failure_code IS NOT NULL)
);
CREATE UNIQUE INDEX once_per_reversal_kind ON wager_transactions(reference_transaction_id,kind) WHERE status='PROCESSED' AND kind IN ('REFUND','ROLLBACK');
CREATE INDEX pending_reference_due ON wager_transactions(next_attempt_at) WHERE status='PENDING_REFERENCE';
CREATE TABLE wallet_ledger (
 sequence bigint GENERATED ALWAYS AS IDENTITY UNIQUE, id uuid PRIMARY KEY, wallet_id uuid NOT NULL, transaction_id uuid NOT NULL REFERENCES wager_transactions(id),
 direction text NOT NULL CHECK(direction IN ('DEBIT','CREDIT')), amount numeric NOT NULL CHECK(amount>0 AND amount<'Infinity'::numeric AND scale(amount)<=2),
 currency char(3) NOT NULL, balance_before numeric NOT NULL CHECK(balance_before>=0 AND balance_before<'Infinity'::numeric AND scale(balance_before)<=2),
 balance_after numeric NOT NULL CHECK(balance_after>=0 AND balance_after<'Infinity'::numeric AND scale(balance_after)<=2), created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(wallet_id,transaction_id), FOREIGN KEY(wallet_id,currency) REFERENCES wallets(id,currency),
 CHECK(balance_after=balance_before+CASE direction WHEN 'CREDIT' THEN amount ELSE -amount END)
);
CREATE INDEX ledger_cursor ON wallet_ledger(wallet_id,sequence);
CREATE TABLE inbox (
 consumer_name text NOT NULL,message_id text NOT NULL,payload_hash text NOT NULL, received_at timestamptz NOT NULL DEFAULT now(),
 processed_at timestamptz,transaction_id uuid REFERENCES wager_transactions(id),PRIMARY KEY(consumer_name,message_id)
);
CREATE TABLE outbox (
 id uuid PRIMARY KEY,aggregate_id uuid NOT NULL,event_type text NOT NULL,payload jsonb NOT NULL,occurred_at timestamptz NOT NULL,
 attempts integer NOT NULL DEFAULT 0,next_attempt_at timestamptz NOT NULL DEFAULT now(),published_at timestamptz,lease_until timestamptz,lease_token uuid
);
CREATE INDEX outbox_due ON outbox(next_attempt_at,occurred_at) WHERE published_at IS NULL;
CREATE TABLE failed_messages (id uuid PRIMARY KEY,message_id text,reason text NOT NULL,body_hash text NOT NULL,created_at timestamptz NOT NULL DEFAULT now());
CREATE FUNCTION immutable_ledger() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'ledger is append-only' USING ERRCODE='23514'; END $$;
CREATE TRIGGER ledger_no_mutation BEFORE UPDATE OR DELETE ON wallet_ledger FOR EACH ROW EXECUTE FUNCTION immutable_ledger();
CREATE FUNCTION terminal_transaction() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF OLD.status IN ('PROCESSED','REJECTED','FAILED') AND NEW IS DISTINCT FROM OLD THEN RAISE EXCEPTION 'terminal transaction' USING ERRCODE='23514'; END IF; RETURN NEW;
END $$;
CREATE TRIGGER terminal_guard BEFORE UPDATE ON wager_transactions FOR EACH ROW EXECUTE FUNCTION terminal_transaction();
CREATE FUNCTION validate_ledger() RETURNS trigger LANGUAGE plpgsql AS $$ DECLARE t wager_transactions; BEGIN
 SELECT * INTO t FROM wager_transactions WHERE id=NEW.transaction_id;
 IF t.status<>'PROCESSED' OR t.kind='LOSS' OR t.wallet_id<>NEW.wallet_id OR t.amount<>NEW.amount OR t.currency<>NEW.currency THEN
 RAISE EXCEPTION 'invalid ledger transaction' USING ERRCODE='23514'; END IF; RETURN NEW;
END $$;
CREATE TRIGGER ledger_valid BEFORE INSERT ON wallet_ledger FOR EACH ROW EXECUTE FUNCTION validate_ledger();
-- Deferred check sees the complete financial transaction, not intermediate writes.
CREATE FUNCTION reconcile_constraint() RETURNS trigger LANGUAGE plpgsql AS $$ DECLARE wid uuid; actual numeric; stored numeric; BEGIN
 IF TG_TABLE_NAME='wallets' THEN wid:=NEW.id; ELSE wid:=NEW.wallet_id; END IF;
 SELECT balance INTO stored FROM wallets WHERE id=wid;
 SELECT coalesce(sum(CASE direction WHEN 'CREDIT' THEN amount ELSE -amount END),0) INTO actual FROM wallet_ledger WHERE wallet_id=wid;
 IF stored IS DISTINCT FROM actual THEN RAISE EXCEPTION 'wallet ledger mismatch' USING ERRCODE='23514'; END IF; RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER wallet_reconciles AFTER INSERT OR UPDATE ON wallets DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION reconcile_constraint();
CREATE CONSTRAINT TRIGGER ledger_reconciles AFTER INSERT ON wallet_ledger DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION reconcile_constraint();

CREATE FUNCTION wallet_version_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NEW.id<>OLD.id OR NEW.player_id<>OLD.player_id OR NEW.currency<>OLD.currency THEN RAISE EXCEPTION 'immutable wallet identity' USING ERRCODE='23514'; END IF;
 IF (NEW.balance<>OLD.balance AND NEW.version<>OLD.version+1) OR (NEW.balance=OLD.balance AND NEW.version<>OLD.version) THEN RAISE EXCEPTION 'invalid wallet version' USING ERRCODE='23514'; END IF; RETURN NEW;
END $$;
CREATE TRIGGER wallet_version BEFORE UPDATE ON wallets FOR EACH ROW EXECUTE FUNCTION wallet_version_guard();
CREATE FUNCTION transaction_ledger_guard() RETURNS trigger LANGUAGE plpgsql AS $$ DECLARE t wager_transactions; n integer; BEGIN
 SELECT * INTO t FROM wager_transactions WHERE id=NEW.id;
 SELECT count(*) INTO n FROM wallet_ledger WHERE transaction_id=t.id;
 IF (t.status='PROCESSED' AND t.kind<>'LOSS' AND n<>1) OR ((t.status<>'PROCESSED' OR t.kind='LOSS') AND n<>0) THEN RAISE EXCEPTION 'transaction ledger mismatch' USING ERRCODE='23514'; END IF; RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER transaction_has_ledger AFTER INSERT OR UPDATE ON wager_transactions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION transaction_ledger_guard();

CREATE TRIGGER ledger_no_truncate BEFORE TRUNCATE ON wallet_ledger FOR EACH STATEMENT EXECUTE FUNCTION immutable_ledger();
