-- =====================================================================
-- Banking ownership boundary enforcement (plan stage B1)
-- =====================================================================

-- 1. Backfill: propagate business_id / branch_id from parent bank account
UPDATE public.bank_transactions bt
SET business_id = ba.business_id,
    branch_id   = ba.branch_id
FROM public.bank_accounts ba
WHERE ba.id = bt.bank_account_id
  AND (bt.business_id IS DISTINCT FROM ba.business_id
       OR bt.branch_id IS DISTINCT FROM ba.branch_id);

-- 2. Backfill: align is_shared with branch_id presence
UPDATE public.bank_accounts
SET is_shared = (branch_id IS NULL)
WHERE is_shared IS DISTINCT FROM (branch_id IS NULL);

-- 3. R1 — unique external connection per business+provider
CREATE UNIQUE INDEX IF NOT EXISTS bank_accounts_external_unique
  ON public.bank_accounts (business_id, provider_id, external_account_id)
  WHERE provider_id IS NOT NULL AND external_account_id IS NOT NULL;

-- 4. R2 — unique manual account_number per business+provider (catches duplicate manual entries)
CREATE UNIQUE INDEX IF NOT EXISTS bank_accounts_manual_unique
  ON public.bank_accounts (business_id, provider_id, account_number)
  WHERE provider_id IS NOT NULL AND account_number IS NOT NULL AND external_account_id IS NULL;

-- 5. R5 — is_shared ⇔ branch_id IS NULL
ALTER TABLE public.bank_accounts
  DROP CONSTRAINT IF EXISTS bank_accounts_shared_branch_consistency;
ALTER TABLE public.bank_accounts
  ADD CONSTRAINT bank_accounts_shared_branch_consistency
  CHECK (
    (is_shared IS NULL) OR
    (is_shared = true  AND branch_id IS NULL) OR
    (is_shared = false AND branch_id IS NOT NULL)
  ) NOT VALID;
-- NOT VALID so legacy rows where is_shared was null aren't blocked; new
-- writes are checked. Validate now that backfill aligned everything:
ALTER TABLE public.bank_accounts
  VALIDATE CONSTRAINT bank_accounts_shared_branch_consistency;

-- 6. R4 — one open reconciliation per bank account
CREATE UNIQUE INDEX IF NOT EXISTS bank_reconciliation_one_open_per_account
  ON public.bank_reconciliation_sessions (bank_account_id)
  WHERE status IN ('in_progress', 'draft');

-- 7. R3 — bank_transactions scope must mirror the parent bank_account
CREATE OR REPLACE FUNCTION public.enforce_bank_txn_scope_matches_account()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_business_id uuid;
  v_branch_id   uuid;
BEGIN
  SELECT business_id, branch_id
    INTO v_business_id, v_branch_id
  FROM public.bank_accounts
  WHERE id = NEW.bank_account_id;

  IF v_business_id IS NULL THEN
    RAISE EXCEPTION 'bank_account % not found or has no business_id', NEW.bank_account_id
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  -- Auto-stamp on insert, validate on update
  NEW.business_id := v_business_id;
  NEW.branch_id   := v_branch_id;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_enforce_bank_txn_scope ON public.bank_transactions;
CREATE TRIGGER trg_enforce_bank_txn_scope
  BEFORE INSERT OR UPDATE OF bank_account_id, business_id, branch_id
  ON public.bank_transactions
  FOR EACH ROW
  EXECUTE FUNCTION public.enforce_bank_txn_scope_matches_account();

-- 8. R3 cascade — when a bank_account's branch_id moves, re-stamp its transactions
CREATE OR REPLACE FUNCTION public.cascade_bank_account_scope_to_txns()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.branch_id IS DISTINCT FROM OLD.branch_id
     OR NEW.business_id IS DISTINCT FROM OLD.business_id THEN
    UPDATE public.bank_transactions
       SET business_id = NEW.business_id,
           branch_id   = NEW.branch_id
     WHERE bank_account_id = NEW.id;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_cascade_bank_account_scope ON public.bank_accounts;
CREATE TRIGGER trg_cascade_bank_account_scope
  AFTER UPDATE OF business_id, branch_id ON public.bank_accounts
  FOR EACH ROW
  EXECUTE FUNCTION public.cascade_bank_account_scope_to_txns();

COMMENT ON INDEX public.bank_accounts_external_unique IS
  'R1: one (business, provider, external_account_id) — prevents duplicate bank feed connections';
COMMENT ON INDEX public.bank_accounts_manual_unique IS
  'R2: one (business, provider, account_number) for manual accounts — prevents duplicate manual entries';
COMMENT ON INDEX public.bank_reconciliation_one_open_per_account IS
  'R4: only one in_progress/draft reconciliation per bank account';
COMMENT ON CONSTRAINT bank_accounts_shared_branch_consistency ON public.bank_accounts IS
  'R5: is_shared must agree with branch_id presence';
COMMENT ON FUNCTION public.enforce_bank_txn_scope_matches_account() IS
  'R3: bank_transactions.business_id/branch_id must mirror the parent bank_account';