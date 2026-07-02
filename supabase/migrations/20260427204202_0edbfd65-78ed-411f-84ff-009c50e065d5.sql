
-- D-1a: pos_kitchen_status enum + backfill on pos_kitchen_orders
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'pos_kitchen_status') THEN
    CREATE TYPE public.pos_kitchen_status AS ENUM
      ('new','sent','cooking','ready','served','cancelled');
  END IF;
END $$;

ALTER TABLE public.pos_kitchen_orders
  ADD COLUMN IF NOT EXISTS status_v2 public.pos_kitchen_status;

UPDATE public.pos_kitchen_orders
SET status_v2 = CASE COALESCE(status,'pending')
    WHEN 'pending'     THEN 'new'::public.pos_kitchen_status
    WHEN 'in_progress' THEN 'cooking'::public.pos_kitchen_status
    WHEN 'ready'       THEN 'ready'::public.pos_kitchen_status
    WHEN 'served'      THEN 'served'::public.pos_kitchen_status
    WHEN 'cancelled'   THEN 'cancelled'::public.pos_kitchen_status
    ELSE 'new'::public.pos_kitchen_status
  END
WHERE status_v2 IS NULL;

ALTER TABLE public.pos_kitchen_orders
  DROP CONSTRAINT IF EXISTS pos_kitchen_orders_status_check;
ALTER TABLE public.pos_kitchen_orders DROP COLUMN status;
ALTER TABLE public.pos_kitchen_orders RENAME COLUMN status_v2 TO status;
ALTER TABLE public.pos_kitchen_orders
  ALTER COLUMN status SET DEFAULT 'new'::public.pos_kitchen_status;
ALTER TABLE public.pos_kitchen_orders
  ALTER COLUMN status SET NOT NULL;

CREATE OR REPLACE FUNCTION public.enforce_pos_kitchen_status_transition()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_rank_old int; v_rank_new int;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status NOT IN ('new','sent') THEN
      RAISE EXCEPTION 'Kitchen ticket % may only start at new|sent (got %)', NEW.id, NEW.status
        USING ERRCODE='check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.status = OLD.status THEN RETURN NEW; END IF;
  v_rank_old := CASE OLD.status WHEN 'new' THEN 1 WHEN 'sent' THEN 2 WHEN 'cooking' THEN 3
    WHEN 'ready' THEN 4 WHEN 'served' THEN 5 WHEN 'cancelled' THEN 99 END;
  v_rank_new := CASE NEW.status WHEN 'new' THEN 1 WHEN 'sent' THEN 2 WHEN 'cooking' THEN 3
    WHEN 'ready' THEN 4 WHEN 'served' THEN 5 WHEN 'cancelled' THEN 99 END;
  IF NEW.status = 'cancelled' AND OLD.status = 'served' THEN
    RAISE EXCEPTION 'Kitchen ticket % cannot be cancelled after served', NEW.id
      USING ERRCODE='check_violation';
  END IF;
  IF NEW.status = 'cancelled' THEN RETURN NEW; END IF;
  IF OLD.status = 'cancelled' THEN
    RAISE EXCEPTION 'Kitchen ticket % is cancelled', NEW.id USING ERRCODE='check_violation';
  END IF;
  IF v_rank_new < v_rank_old THEN
    RAISE EXCEPTION 'Kitchen ticket % illegal backward % → %', NEW.id, OLD.status, NEW.status
      USING ERRCODE='check_violation';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_pos_kitchen_status_transition ON public.pos_kitchen_orders;
CREATE TRIGGER trg_pos_kitchen_status_transition
  BEFORE INSERT OR UPDATE OF status ON public.pos_kitchen_orders
  FOR EACH ROW EXECUTE FUNCTION public.enforce_pos_kitchen_status_transition();

-- D-1b: pos_table_session_status
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'pos_table_session_status') THEN
    CREATE TYPE public.pos_table_session_status AS ENUM
      ('open','ordered','served','paid','closed');
  END IF;
END $$;

ALTER TABLE public.pos_table_sessions
  ADD COLUMN IF NOT EXISTS status_v2 public.pos_table_session_status;

UPDATE public.pos_table_sessions
SET status_v2 = CASE COALESCE(status,'available')
    WHEN 'available'       THEN 'open'::public.pos_table_session_status
    WHEN 'occupied'        THEN 'ordered'::public.pos_table_session_status
    WHEN 'reserved'        THEN 'open'::public.pos_table_session_status
    WHEN 'pending_payment' THEN 'served'::public.pos_table_session_status
    ELSE 'open'::public.pos_table_session_status
  END
WHERE status_v2 IS NULL;

ALTER TABLE public.pos_table_sessions
  DROP CONSTRAINT IF EXISTS pos_table_sessions_status_check;
ALTER TABLE public.pos_table_sessions DROP COLUMN status;
ALTER TABLE public.pos_table_sessions RENAME COLUMN status_v2 TO status;
ALTER TABLE public.pos_table_sessions
  ALTER COLUMN status SET DEFAULT 'open'::public.pos_table_session_status;
ALTER TABLE public.pos_table_sessions
  ALTER COLUMN status SET NOT NULL;

CREATE OR REPLACE FUNCTION public.enforce_pos_table_session_status_transition()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_rank_old int; v_rank_new int;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status NOT IN ('open','ordered') THEN
      RAISE EXCEPTION 'Table session % may only start at open|ordered (got %)', NEW.id, NEW.status
        USING ERRCODE='check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.status = OLD.status THEN RETURN NEW; END IF;
  v_rank_old := CASE OLD.status WHEN 'open' THEN 1 WHEN 'ordered' THEN 2 WHEN 'served' THEN 3
    WHEN 'paid' THEN 4 WHEN 'closed' THEN 5 END;
  v_rank_new := CASE NEW.status WHEN 'open' THEN 1 WHEN 'ordered' THEN 2 WHEN 'served' THEN 3
    WHEN 'paid' THEN 4 WHEN 'closed' THEN 5 END;
  IF v_rank_new < v_rank_old THEN
    RAISE EXCEPTION 'Table session % illegal backward % → %', NEW.id, OLD.status, NEW.status
      USING ERRCODE='check_violation';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_pos_table_session_status_transition ON public.pos_table_sessions;
CREATE TRIGGER trg_pos_table_session_status_transition
  BEFORE INSERT OR UPDATE OF status ON public.pos_table_sessions
  FOR EACH ROW EXECUTE FUNCTION public.enforce_pos_table_session_status_transition();

-- D-3: validate payment-method GL constraint
UPDATE public.pos_payment_methods
SET is_enabled = false
WHERE is_enabled = true AND debit_account_id IS NULL;

ALTER TABLE public.pos_payment_methods
  VALIDATE CONSTRAINT pos_payment_methods_enabled_requires_account;

-- E-1: drop redundant indexes
DROP INDEX IF EXISTS public.idx_pos_transactions_status;
DROP INDEX IF EXISTS public.idx_pos_transactions_shift;
DROP INDEX IF EXISTS public.idx_pos_transactions_shift_type_synced;
DROP INDEX IF EXISTS public.idx_pos_transactions_org_created;

-- E-2: archive tables
CREATE TABLE IF NOT EXISTS public.pos_transactions_archive
  (LIKE public.pos_transactions INCLUDING DEFAULTS INCLUDING CONSTRAINTS);
CREATE TABLE IF NOT EXISTS public.pos_transaction_items_archive
  (LIKE public.pos_transaction_items INCLUDING DEFAULTS INCLUDING CONSTRAINTS);

ALTER TABLE public.pos_transactions_archive
  ADD COLUMN IF NOT EXISTS archived_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE public.pos_transaction_items_archive
  ADD COLUMN IF NOT EXISTS archived_at timestamptz NOT NULL DEFAULT now();

CREATE INDEX IF NOT EXISTS idx_pos_tx_arch_business_date
  ON public.pos_transactions_archive (business_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_pos_tx_arch_shift
  ON public.pos_transactions_archive (shift_id);
CREATE INDEX IF NOT EXISTS idx_pos_tx_items_arch_tx
  ON public.pos_transaction_items_archive (transaction_id);

ALTER TABLE public.pos_transactions_archive ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pos_transaction_items_archive ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS pos_tx_archive_read ON public.pos_transactions_archive;
CREATE POLICY pos_tx_archive_read
  ON public.pos_transactions_archive
  FOR SELECT TO authenticated
  USING (public.user_can_access_business(auth.uid(), business_id));

DROP POLICY IF EXISTS pos_tx_items_archive_read ON public.pos_transaction_items_archive;
CREATE POLICY pos_tx_items_archive_read
  ON public.pos_transaction_items_archive
  FOR SELECT TO authenticated
  USING (public.user_can_access_business(auth.uid(), business_id));

CREATE OR REPLACE FUNCTION public.archive_old_pos_transactions(
  _older_than_days int DEFAULT 90,
  _batch_size int DEFAULT 5000
)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_moved_tx int := 0;
  v_moved_items int := 0;
  v_ids uuid[];
BEGIN
  SELECT array_agg(t.id) INTO v_ids
  FROM (
    SELECT t.id
    FROM public.pos_transactions t
    JOIN public.pos_shifts s ON s.id = t.shift_id
    WHERE s.gl_posted_at IS NOT NULL
      AND s.gl_posted_at < (now() - make_interval(days => _older_than_days))
    LIMIT _batch_size
  ) t;

  IF v_ids IS NULL OR array_length(v_ids, 1) IS NULL THEN
    RETURN jsonb_build_object('moved_transactions', 0, 'moved_items', 0);
  END IF;

  WITH moved AS (
    DELETE FROM public.pos_transaction_items
    WHERE transaction_id = ANY (v_ids)
    RETURNING *
  )
  INSERT INTO public.pos_transaction_items_archive
  SELECT m.*, now() FROM moved m;
  GET DIAGNOSTICS v_moved_items = ROW_COUNT;

  WITH moved AS (
    DELETE FROM public.pos_transactions
    WHERE id = ANY (v_ids)
    RETURNING *
  )
  INSERT INTO public.pos_transactions_archive
  SELECT m.*, now() FROM moved m;
  GET DIAGNOSTICS v_moved_tx = ROW_COUNT;

  RETURN jsonb_build_object(
    'moved_transactions', v_moved_tx,
    'moved_items',        v_moved_items
  );
END;
$$;

REVOKE ALL ON FUNCTION public.archive_old_pos_transactions(int,int) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.archive_old_pos_transactions(int,int) TO service_role;
