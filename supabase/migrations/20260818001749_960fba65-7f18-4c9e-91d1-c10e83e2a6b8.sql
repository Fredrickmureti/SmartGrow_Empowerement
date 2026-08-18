-- ── Banking Wave 1 / Step 1 — lifecycle, provenance, concurrency ──
DO $$ BEGIN
  CREATE TYPE public.bank_account_lifecycle_status AS ENUM ('draft','active','suspended','closed');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE public.bank_accounts
  ADD COLUMN IF NOT EXISTS lifecycle_status public.bank_account_lifecycle_status NOT NULL DEFAULT 'draft',
  ADD COLUMN IF NOT EXISTS activated_at timestamptz,
  ADD COLUMN IF NOT EXISTS closed_at timestamptz,
  ADD COLUMN IF NOT EXISTS closed_reason text,
  ADD COLUMN IF NOT EXISTS opening_balance_je_id uuid REFERENCES public.journal_entries(id),
  ADD COLUMN IF NOT EXISTS row_version integer NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS bank_reported_balance numeric,
  ADD COLUMN IF NOT EXISTS bank_balance_as_of timestamptz;

-- Backfill lifecycle from the legacy boolean.
UPDATE public.bank_accounts
   SET lifecycle_status = CASE WHEN COALESCE(is_active, true) THEN 'active'::public.bank_account_lifecycle_status
                               ELSE 'suspended'::public.bank_account_lifecycle_status END,
       activated_at = COALESCE(activated_at, CASE WHEN COALESCE(is_active, true) THEN created_at END)
 WHERE lifecycle_status = 'draft';

-- Bank-reported balance seeded from the legacy current_balance (feed-reported figure).
UPDATE public.bank_accounts
   SET bank_reported_balance = current_balance,
       bank_balance_as_of = COALESCE(last_sync_at, updated_at)
 WHERE bank_reported_balance IS NULL AND current_balance IS NOT NULL;

-- is_active is now a derived compatibility read of lifecycle_status, and
-- row_version increments on every mutation. Named `aa_` so it runs before the
-- existing BEFORE triggers that validate the derived values.
CREATE OR REPLACE FUNCTION public._bank_account_derive_state()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  NEW.is_active := (NEW.lifecycle_status = 'active');
  NEW.is_shared := (NEW.branch_id IS NULL);
  IF TG_OP = 'UPDATE' THEN
    NEW.row_version := COALESCE(OLD.row_version, 1) + 1;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS aa_bank_account_derive_state ON public.bank_accounts;
CREATE TRIGGER aa_bank_account_derive_state
BEFORE INSERT OR UPDATE ON public.bank_accounts
FOR EACH ROW EXECUTE FUNCTION public._bank_account_derive_state();

CREATE INDEX IF NOT EXISTS bank_accounts_lifecycle_idx
  ON public.bank_accounts (business_id, lifecycle_status);