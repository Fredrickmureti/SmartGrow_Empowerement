-- =====================================================================
-- ARCHITECTURE AUDIT — STAGE 1
-- Branch dimension on GL + audit-trail protection + CRM company-isolation
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Tighten POS FKs: never lose audit lineage on branch/company delete
-- ---------------------------------------------------------------------
ALTER TABLE public.pos_transactions
  DROP CONSTRAINT IF EXISTS pos_transactions_branch_id_fkey,
  DROP CONSTRAINT IF EXISTS pos_transactions_business_id_fkey;

ALTER TABLE public.pos_transactions
  ADD CONSTRAINT pos_transactions_branch_id_fkey
    FOREIGN KEY (branch_id) REFERENCES public.branches(id) ON DELETE RESTRICT,
  ADD CONSTRAINT pos_transactions_business_id_fkey
    FOREIGN KEY (business_id) REFERENCES public.businesses(id) ON DELETE RESTRICT;

-- ---------------------------------------------------------------------
-- 2. Branch dimension on the General Ledger
-- ---------------------------------------------------------------------
ALTER TABLE public.journal_entries
  ADD COLUMN IF NOT EXISTS branch_id uuid NULL
    REFERENCES public.branches(id) ON DELETE RESTRICT;

ALTER TABLE public.journal_entry_lines
  ADD COLUMN IF NOT EXISTS branch_id uuid NULL
    REFERENCES public.branches(id) ON DELETE RESTRICT;

ALTER TABLE public.invoices
  ADD COLUMN IF NOT EXISTS branch_id uuid NULL
    REFERENCES public.branches(id) ON DELETE RESTRICT;

ALTER TABLE public.bills
  ADD COLUMN IF NOT EXISTS branch_id uuid NULL
    REFERENCES public.branches(id) ON DELETE RESTRICT;

-- ---------------------------------------------------------------------
-- 3. Trigger: branch must belong to the row's business
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.enforce_branch_business_match()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_branch_business uuid;
BEGIN
  IF NEW.branch_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT business_id INTO v_branch_business
  FROM public.branches
  WHERE id = NEW.branch_id;

  IF v_branch_business IS NULL THEN
    RAISE EXCEPTION 'branch_id % does not exist', NEW.branch_id;
  END IF;

  IF v_branch_business <> NEW.business_id THEN
    RAISE EXCEPTION
      'branch_id % belongs to business % but row is on business % — cross-company branch assignment is forbidden',
      NEW.branch_id, v_branch_business, NEW.business_id;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_je_branch_business_match ON public.journal_entries;
CREATE TRIGGER trg_je_branch_business_match
  BEFORE INSERT OR UPDATE OF branch_id, business_id ON public.journal_entries
  FOR EACH ROW EXECUTE FUNCTION public.enforce_branch_business_match();

DROP TRIGGER IF EXISTS trg_invoices_branch_business_match ON public.invoices;
CREATE TRIGGER trg_invoices_branch_business_match
  BEFORE INSERT OR UPDATE OF branch_id, business_id ON public.invoices
  FOR EACH ROW EXECUTE FUNCTION public.enforce_branch_business_match();

DROP TRIGGER IF EXISTS trg_bills_branch_business_match ON public.bills;
CREATE TRIGGER trg_bills_branch_business_match
  BEFORE INSERT OR UPDATE OF branch_id, business_id ON public.bills
  FOR EACH ROW EXECUTE FUNCTION public.enforce_branch_business_match();

-- ---------------------------------------------------------------------
-- 4. Trigger: JE-line branch must equal its header branch
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.enforce_je_line_branch_match()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_header_branch uuid;
  v_header_business uuid;
BEGIN
  SELECT branch_id, business_id
  INTO v_header_branch, v_header_business
  FROM public.journal_entries
  WHERE id = NEW.journal_entry_id;

  IF v_header_business IS NULL THEN
    RAISE EXCEPTION 'journal_entry % not found', NEW.journal_entry_id;
  END IF;

  -- Auto-fill from header when caller didn't set it (most common path).
  IF NEW.branch_id IS NULL AND v_header_branch IS NOT NULL THEN
    NEW.branch_id := v_header_branch;
  END IF;

  IF (NEW.branch_id IS DISTINCT FROM v_header_branch) THEN
    RAISE EXCEPTION
      'journal_entry_line.branch_id (%) must match parent journal_entries.branch_id (%)',
      NEW.branch_id, v_header_branch;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_je_line_branch_match ON public.journal_entry_lines;
CREATE TRIGGER trg_je_line_branch_match
  BEFORE INSERT OR UPDATE OF branch_id, journal_entry_id ON public.journal_entry_lines
  FOR EACH ROW EXECUTE FUNCTION public.enforce_je_line_branch_match();

-- ---------------------------------------------------------------------
-- 5. Backfill invoices.branch_id from POS lineage where possible
-- ---------------------------------------------------------------------
UPDATE public.invoices i
SET branch_id = pt.branch_id
FROM public.pos_transactions pt
WHERE pt.invoice_id = i.id
  AND i.branch_id IS NULL
  AND pt.branch_id IS NOT NULL
  AND pt.business_id = i.business_id;

-- ---------------------------------------------------------------------
-- 6. Performance indexes for per-branch reporting
-- ---------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_journal_entries_business_branch
  ON public.journal_entries(business_id, branch_id);
CREATE INDEX IF NOT EXISTS idx_journal_entry_lines_branch
  ON public.journal_entry_lines(branch_id);
CREATE INDEX IF NOT EXISTS idx_invoices_business_branch
  ON public.invoices(business_id, branch_id);
CREATE INDEX IF NOT EXISTS idx_bills_business_branch
  ON public.bills(business_id, branch_id);
CREATE INDEX IF NOT EXISTS idx_pos_transactions_business_branch
  ON public.pos_transactions(business_id, branch_id);

-- ---------------------------------------------------------------------
-- 7. Cross-company isolation for CRM / customer taxonomies
--    (currently org-scoped only → leak between sister companies)
-- ---------------------------------------------------------------------

-- Helper: pick a primary business for an org (oldest active company)
CREATE OR REPLACE FUNCTION public._primary_business_for_org(_org uuid)
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT id FROM public.businesses
  WHERE organization_id = _org AND is_active = true
  ORDER BY created_at ASC
  LIMIT 1;
$$;

-- customer_groups
ALTER TABLE public.customer_groups
  ADD COLUMN IF NOT EXISTS business_id uuid NULL
    REFERENCES public.businesses(id) ON DELETE CASCADE;

UPDATE public.customer_groups cg
SET business_id = public._primary_business_for_org(cg.organization_id)
WHERE cg.business_id IS NULL;

DELETE FROM public.customer_groups WHERE business_id IS NULL;
ALTER TABLE public.customer_groups ALTER COLUMN business_id SET NOT NULL;
CREATE INDEX IF NOT EXISTS idx_customer_groups_business ON public.customer_groups(business_id);

-- crm_lost_reasons
ALTER TABLE public.crm_lost_reasons
  ADD COLUMN IF NOT EXISTS business_id uuid NULL
    REFERENCES public.businesses(id) ON DELETE CASCADE;

UPDATE public.crm_lost_reasons r
SET business_id = public._primary_business_for_org(r.organization_id)
WHERE r.business_id IS NULL;

DELETE FROM public.crm_lost_reasons WHERE business_id IS NULL;
ALTER TABLE public.crm_lost_reasons ALTER COLUMN business_id SET NOT NULL;
CREATE INDEX IF NOT EXISTS idx_crm_lost_reasons_business ON public.crm_lost_reasons(business_id);

-- crm_activity_types
ALTER TABLE public.crm_activity_types
  ADD COLUMN IF NOT EXISTS business_id uuid NULL
    REFERENCES public.businesses(id) ON DELETE CASCADE;

UPDATE public.crm_activity_types t
SET business_id = public._primary_business_for_org(t.organization_id)
WHERE t.business_id IS NULL;

DELETE FROM public.crm_activity_types WHERE business_id IS NULL;
ALTER TABLE public.crm_activity_types ALTER COLUMN business_id SET NOT NULL;
CREATE INDEX IF NOT EXISTS idx_crm_activity_types_business ON public.crm_activity_types(business_id);

-- contact_addresses (must follow the contact's company)
ALTER TABLE public.contact_addresses
  ADD COLUMN IF NOT EXISTS business_id uuid NULL
    REFERENCES public.businesses(id) ON DELETE CASCADE;

UPDATE public.contact_addresses ca
SET business_id = c.business_id
FROM public.contacts c
WHERE ca.contact_id = c.id AND ca.business_id IS NULL;

-- Any orphaned addresses (no contact) → drop
DELETE FROM public.contact_addresses WHERE business_id IS NULL;
ALTER TABLE public.contact_addresses ALTER COLUMN business_id SET NOT NULL;
CREATE INDEX IF NOT EXISTS idx_contact_addresses_business ON public.contact_addresses(business_id);

COMMENT ON COLUMN public.journal_entries.branch_id IS
  'Optional branch dimension. NULL = company-level entry (e.g. depreciation, year-end). Non-NULL must belong to journal_entries.business_id (enforced by trg_je_branch_business_match).';
COMMENT ON COLUMN public.invoices.branch_id IS
  'Branch the invoice was issued from. Backfilled from pos_transactions where applicable. Used for per-branch sales reports.';
COMMENT ON COLUMN public.bills.branch_id IS
  'Branch the bill was incurred at. Used for per-branch expense reports.';
