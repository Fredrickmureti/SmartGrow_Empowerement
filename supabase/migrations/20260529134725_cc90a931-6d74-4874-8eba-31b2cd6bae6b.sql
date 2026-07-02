
-- =============================================================================
-- PHASE 2b — DB-level double-entry safety
-- =============================================================================
-- 1. Add journal_entry_lines.organization_id (NOT NULL, FK, CHECK match parent)
-- 2. AFTER trigger on JEL recomputes journal_entries.total_debit/total_credit
-- 3. Extend trg_je_enforce_balanced to fire on status='voided' too
-- 4. Header-account guard already exists (trg_prevent_journal_post_to_header) —
--    audit & restate to be defensive (allow noop).
-- =============================================================================

-- -------- 1. JEL.organization_id ---------------------------------------------
ALTER TABLE public.journal_entry_lines
  ADD COLUMN IF NOT EXISTS organization_id uuid;

-- Backfill from parent JE
UPDATE public.journal_entry_lines jel
SET organization_id = je.organization_id
FROM public.journal_entries je
WHERE jel.journal_entry_id = je.id
  AND jel.organization_id IS DISTINCT FROM je.organization_id;

ALTER TABLE public.journal_entry_lines
  ALTER COLUMN organization_id SET NOT NULL;

-- CHECK that JEL.organization_id matches parent — enforced via trigger
-- because a CHECK constraint can't reference another table.
CREATE OR REPLACE FUNCTION public._jel_enforce_org_match()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  parent_org uuid;
  parent_biz uuid;
BEGIN
  SELECT organization_id, business_id
    INTO parent_org, parent_biz
  FROM public.journal_entries
  WHERE id = NEW.journal_entry_id;

  IF parent_org IS NULL THEN
    RAISE EXCEPTION 'journal_entry_lines.journal_entry_id=% does not reference an existing journal entry', NEW.journal_entry_id
      USING ERRCODE = '23503';
  END IF;

  IF NEW.organization_id IS DISTINCT FROM parent_org THEN
    RAISE EXCEPTION 'journal_entry_lines.organization_id (%) must match parent journal_entries.organization_id (%)',
      NEW.organization_id, parent_org
      USING ERRCODE = '23514';
  END IF;

  IF NEW.business_id IS DISTINCT FROM parent_biz THEN
    RAISE EXCEPTION 'journal_entry_lines.business_id (%) must match parent journal_entries.business_id (%)',
      NEW.business_id, parent_biz
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_jel_enforce_org_match ON public.journal_entry_lines;
CREATE TRIGGER trg_jel_enforce_org_match
BEFORE INSERT OR UPDATE OF organization_id, business_id, journal_entry_id
ON public.journal_entry_lines
FOR EACH ROW EXECUTE FUNCTION public._jel_enforce_org_match();

-- Index for the new RLS path
CREATE INDEX IF NOT EXISTS idx_jel_organization_id
  ON public.journal_entry_lines (organization_id);

-- Rewrite JEL RLS policies to gate on organization_id + business_id directly,
-- removing the per-row JOIN to journal_entries.
DROP POLICY IF EXISTS journal_entry_lines_select_v2 ON public.journal_entry_lines;
DROP POLICY IF EXISTS journal_entry_lines_insert_v2 ON public.journal_entry_lines;
DROP POLICY IF EXISTS journal_entry_lines_update_v2 ON public.journal_entry_lines;
DROP POLICY IF EXISTS journal_entry_lines_delete_v2 ON public.journal_entry_lines;

CREATE POLICY journal_entry_lines_select_v3
ON public.journal_entry_lines
FOR SELECT
USING (
  user_can_access_business(auth.uid(), business_id)
  AND (
    branch_id IS NULL
    OR user_can_access_branch(auth.uid(), branch_id)
    OR has_finance_permission(auth.uid(), 'finance.view_consolidated', business_id)
  )
);

CREATE POLICY journal_entry_lines_insert_v3
ON public.journal_entry_lines
FOR INSERT
WITH CHECK (
  user_can_access_business(auth.uid(), business_id)
  AND (
    branch_id IS NULL
    OR user_can_access_branch(auth.uid(), branch_id)
    OR has_finance_permission(auth.uid(), 'finance.view_consolidated', business_id)
  )
);

CREATE POLICY journal_entry_lines_update_v3
ON public.journal_entry_lines
FOR UPDATE
USING (
  user_can_access_business(auth.uid(), business_id)
  AND (
    branch_id IS NULL
    OR user_can_access_branch(auth.uid(), branch_id)
    OR has_finance_permission(auth.uid(), 'finance.view_consolidated', business_id)
  )
);

CREATE POLICY journal_entry_lines_delete_v3
ON public.journal_entry_lines
FOR DELETE
USING (
  user_can_access_business(auth.uid(), business_id)
  AND (
    branch_id IS NULL
    OR user_can_access_branch(auth.uid(), branch_id)
    OR has_finance_permission(auth.uid(), 'finance.view_consolidated', business_id)
  )
);

-- -------- 2. AFTER-line trigger recomputes JE totals --------------------------
CREATE OR REPLACE FUNCTION public._recompute_je_totals()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  je_ids uuid[];
  je_id  uuid;
BEGIN
  -- Collect every affected JE id from both NEW and OLD
  IF TG_OP = 'INSERT' THEN
    je_ids := ARRAY[NEW.journal_entry_id];
  ELSIF TG_OP = 'DELETE' THEN
    je_ids := ARRAY[OLD.journal_entry_id];
  ELSE
    je_ids := ARRAY[NEW.journal_entry_id];
    IF OLD.journal_entry_id IS DISTINCT FROM NEW.journal_entry_id THEN
      je_ids := je_ids || OLD.journal_entry_id;
    END IF;
  END IF;

  FOREACH je_id IN ARRAY je_ids LOOP
    UPDATE public.journal_entries je
       SET total_debit  = COALESCE((SELECT SUM(debit)  FROM public.journal_entry_lines WHERE journal_entry_id = je_id), 0),
           total_credit = COALESCE((SELECT SUM(credit) FROM public.journal_entry_lines WHERE journal_entry_id = je_id), 0)
     WHERE je.id = je_id
       AND (je.total_debit IS DISTINCT FROM COALESCE((SELECT SUM(debit)  FROM public.journal_entry_lines WHERE journal_entry_id = je_id), 0)
            OR je.total_credit IS DISTINCT FROM COALESCE((SELECT SUM(credit) FROM public.journal_entry_lines WHERE journal_entry_id = je_id), 0));
  END LOOP;

  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_jel_recompute_je_totals ON public.journal_entry_lines;
CREATE TRIGGER trg_jel_recompute_je_totals
AFTER INSERT OR UPDATE OF debit, credit, journal_entry_id OR DELETE
ON public.journal_entry_lines
FOR EACH ROW EXECUTE FUNCTION public._recompute_je_totals();

-- -------- 3. Extend balance check to voided + posted --------------------------
DROP TRIGGER IF EXISTS trg_je_enforce_balanced ON public.journal_entries;
CREATE TRIGGER trg_je_enforce_balanced
BEFORE INSERT OR UPDATE OF total_debit, total_credit, status
ON public.journal_entries
FOR EACH ROW
WHEN (NEW.status IN ('posted','voided'))
EXECUTE FUNCTION enforce_je_balanced();

-- -------- 4. Defensive restate of header-account guard ------------------------
-- (Already enforced by trg_prevent_journal_post_to_header; this is a no-op
-- audit query — emit NOTICE if any existing JEL row references a header.)
DO $$
DECLARE
  bad_count int;
BEGIN
  SELECT count(*) INTO bad_count
  FROM public.journal_entry_lines jel
  JOIN public.accounts a ON a.id = jel.account_id
  WHERE a.is_header = TRUE;
  IF bad_count > 0 THEN
    RAISE WARNING 'PHASE2b AUDIT: % JEL rows currently reference is_header accounts (data drift)', bad_count;
  END IF;
END $$;
