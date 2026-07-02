
-- =====================================================================
-- PHASE E: user_active_business → per-org source of truth
-- PHASE F: branches → demoted to analytic_accounts (Odoo-pure)
-- PHASE H: integrity helpers used by nightly job
-- =====================================================================

-- ── Phase E ────────────────────────────────────────────────────────────
-- Add organization_id so each user can have one active business per org.
ALTER TABLE public.user_active_business
  ADD COLUMN IF NOT EXISTS organization_id uuid REFERENCES public.organizations(id) ON DELETE CASCADE;

-- Backfill org from current rows (one row per user pre-migration).
UPDATE public.user_active_business uab
SET organization_id = b.organization_id
FROM public.businesses b
WHERE uab.business_id = b.id
  AND uab.organization_id IS NULL;

-- Drop existing PK on (user_id) since it now needs to be (user_id, org).
ALTER TABLE public.user_active_business DROP CONSTRAINT IF EXISTS user_active_business_pkey;

-- Composite PK enforces "one active business per (user, org)".
ALTER TABLE public.user_active_business
  ALTER COLUMN organization_id SET NOT NULL,
  ADD CONSTRAINT user_active_business_pkey PRIMARY KEY (user_id, organization_id);

-- Ensure the active business actually belongs to that org (defensive).
CREATE OR REPLACE FUNCTION public.enforce_active_business_org_match()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  biz_org uuid;
BEGIN
  SELECT organization_id INTO biz_org FROM public.businesses WHERE id = NEW.business_id;
  IF biz_org IS NULL THEN
    RAISE EXCEPTION 'business % does not exist', NEW.business_id;
  END IF;
  IF biz_org <> NEW.organization_id THEN
    RAISE EXCEPTION 'business % belongs to organization %, not %', NEW.business_id, biz_org, NEW.organization_id;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_active_business_org_match ON public.user_active_business;
CREATE TRIGGER trg_active_business_org_match
  BEFORE INSERT OR UPDATE ON public.user_active_business
  FOR EACH ROW EXECUTE FUNCTION public.enforce_active_business_org_match();

-- Realtime so multi-tab sees switches.
ALTER TABLE public.user_active_business REPLICA IDENTITY FULL;
DO $$ BEGIN
  PERFORM 1 FROM pg_publication_tables WHERE pubname='supabase_realtime' AND tablename='user_active_business';
  IF NOT FOUND THEN
    EXECUTE 'ALTER PUBLICATION supabase_realtime ADD TABLE public.user_active_business';
  END IF;
END $$;


-- ── Phase H: integrity helpers ─────────────────────────────────────────
-- Detect cross-business journal lines (line.account.business_id ≠ je.business_id).
CREATE OR REPLACE FUNCTION public.find_cross_business_journal_lines()
RETURNS TABLE(
  line_id uuid,
  entry_id uuid,
  entry_business_id uuid,
  account_id uuid,
  account_business_id uuid
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT jel.id, je.id, je.business_id, jel.account_id, a.business_id
  FROM journal_entry_lines jel
  JOIN journal_entries je ON je.id = jel.journal_entry_id
  JOIN accounts a ON a.id = jel.account_id
  WHERE a.business_id <> je.business_id
$$;

-- Detect invoice/contact business mismatches.
CREATE OR REPLACE FUNCTION public.find_invoice_contact_business_mismatches()
RETURNS TABLE(
  invoice_id uuid,
  invoice_business_id uuid,
  contact_id uuid,
  contact_business_id uuid
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT i.id, i.business_id, i.contact_id, c.business_id
  FROM invoices i
  JOIN contacts c ON c.id = i.contact_id
  WHERE c.business_id IS NOT NULL
    AND i.business_id <> c.business_id
$$;

-- Detect bill/vendor business mismatches.
CREATE OR REPLACE FUNCTION public.find_bill_vendor_business_mismatches()
RETURNS TABLE(
  bill_id uuid,
  bill_business_id uuid,
  vendor_id uuid,
  vendor_business_id uuid
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT b.id, b.business_id, b.vendor_id, c.business_id
  FROM bills b
  JOIN contacts c ON c.id = b.vendor_id
  WHERE c.business_id IS NOT NULL
    AND b.business_id <> c.business_id
$$;
