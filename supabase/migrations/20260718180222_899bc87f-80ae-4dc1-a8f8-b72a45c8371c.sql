-- ============================================================
-- Phase 3 · Batch T2 — POS idempotency is mandatory
-- ADR 0082 D3
-- ============================================================
-- The T1 migration kept `p_idempotency_key text DEFAULT NULL` on
-- `process_pos_transaction` for backwards-compatibility. T2 makes the
-- invariant enforceable at the storage layer: a `pos_transactions`
-- row without an `idempotency_key` is a bug — network retries can
-- no longer collapse onto it, and offline replay produces duplicates.
--
-- We enforce this with a BEFORE INSERT trigger rather than an
-- `ALTER COLUMN ... SET NOT NULL` so existing historical rows with
-- NULL keys remain valid (they predate the invariant) while every
-- new commit must supply a key. The partial unique index shipped in
-- the Phase C migration
--   (organization_id, business_id, register_id, idempotency_key)
-- WHERE idempotency_key IS NOT NULL
-- continues to collapse replays onto a single row.

CREATE OR REPLACE FUNCTION public.tg_pos_transactions_require_idempotency_key()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $$
BEGIN
  IF NEW.idempotency_key IS NULL OR btrim(NEW.idempotency_key) = '' THEN
    RAISE EXCEPTION
      'pos_transactions.idempotency_key is required (ADR 0082 D3 · Batch T2). '
      'Callers must supply p_idempotency_key to process_pos_transaction so '
      'network retries and offline replays collapse onto a single row.'
      USING ERRCODE = 'not_null_violation';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_pos_transactions_require_idempotency_key
  ON public.pos_transactions;
CREATE TRIGGER trg_pos_transactions_require_idempotency_key
BEFORE INSERT ON public.pos_transactions
FOR EACH ROW
EXECUTE FUNCTION public.tg_pos_transactions_require_idempotency_key();

COMMENT ON TRIGGER trg_pos_transactions_require_idempotency_key
  ON public.pos_transactions IS
'ADR 0082 · Batch T2 — every committed POS transaction must carry an idempotency_key so retries and offline replays are safe. Historical NULL rows are untouched; new inserts are rejected.';
