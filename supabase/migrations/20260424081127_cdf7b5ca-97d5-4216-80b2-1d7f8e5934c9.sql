-- =========================================================================
-- 1) Undo the misplaced fiscal-period trigger from Migration 1 on journal_entries.
--    The existing enforce_fiscal_period_lock() reads NEW.journal_entry_id,
--    which only exists on journal_entry_lines.
-- =========================================================================
DROP TRIGGER IF EXISTS trg_fiscal_period_lock ON public.journal_entries;

-- Attach to the correct table (lines):
DROP TRIGGER IF EXISTS trg_fiscal_period_lock ON public.journal_entry_lines;
CREATE TRIGGER trg_fiscal_period_lock
  BEFORE INSERT ON public.journal_entry_lines
  FOR EACH ROW EXECUTE FUNCTION public.enforce_fiscal_period_lock();

-- =========================================================================
-- 2) Header-level companion check: stop direct entry inserts/date changes
--    targeting a closed period or a lock-dated org. Independent of the line
--    trigger so even an empty draft can't slip through.
-- =========================================================================
CREATE OR REPLACE FUNCTION public.enforce_fiscal_period_lock_header()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  locked_period RECORD;
  reset_org     TEXT;
  org_lock      RECORD;
BEGIN
  -- Allow controlled org-wide resets (used by data-reset tooling).
  reset_org := current_setting('app.reset_in_progress', true);
  IF reset_org IS NOT NULL AND reset_org <> ''
     AND NEW.organization_id::text = reset_org THEN
    RETURN NEW;
  END IF;

  -- Hard fiscal-period lock (Odoo parity: closed period blocks all moves).
  SELECT fp.id, fp.name INTO locked_period
  FROM public.fiscal_periods fp
  WHERE fp.organization_id = NEW.organization_id
    AND fp.status = 'closed'
    AND NEW.entry_date BETWEEN fp.start_date AND fp.end_date
    AND (fp.business_id = NEW.business_id OR fp.business_id IS NULL)
  LIMIT 1;

  IF FOUND THEN
    RAISE EXCEPTION 'Cannot post journal entry to closed fiscal period: %',
      locked_period.name
      USING ERRCODE = 'check_violation';
  END IF;

  -- Lock-date hierarchy (Odoo parity):
  --   fiscalyear_lock_date — applies to everyone
  --   period_lock_date     — applies to everyone except advisors
  --   tax_lock_date        — applies to tax-impacting entries
  -- We block on fiscalyear_lock_date here (the universal one). The other two
  -- are checked at RPC layer where the user role is known.
  SELECT fiscalyear_lock_date INTO org_lock
  FROM public.organizations
  WHERE id = NEW.organization_id;

  IF org_lock.fiscalyear_lock_date IS NOT NULL
     AND NEW.entry_date <= org_lock.fiscalyear_lock_date THEN
    RAISE EXCEPTION
      'Cannot post on or before fiscal-year lock date %',
      org_lock.fiscalyear_lock_date
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_fiscal_period_lock_header ON public.journal_entries;
CREATE TRIGGER trg_fiscal_period_lock_header
  BEFORE INSERT OR UPDATE OF entry_date, status ON public.journal_entries
  FOR EACH ROW EXECUTE FUNCTION public.enforce_fiscal_period_lock_header();

-- =========================================================================
-- 3) Migration 4: add lock-date hierarchy columns to organizations.
--    Idempotent.
-- =========================================================================
ALTER TABLE public.organizations
  ADD COLUMN IF NOT EXISTS fiscalyear_lock_date DATE,
  ADD COLUMN IF NOT EXISTS period_lock_date     DATE,
  ADD COLUMN IF NOT EXISTS tax_lock_date        DATE;

COMMENT ON COLUMN public.organizations.fiscalyear_lock_date IS
  'Hard lock — no one (incl. admins) can post on/before this date. Set after year-end audit sign-off.';
COMMENT ON COLUMN public.organizations.period_lock_date IS
  'Soft lock — non-advisor users blocked from posting on/before this date.';
COMMENT ON COLUMN public.organizations.tax_lock_date IS
  'Tax cutoff — blocks tax-impacting entries (invoices/bills with tax) on/before this date.';