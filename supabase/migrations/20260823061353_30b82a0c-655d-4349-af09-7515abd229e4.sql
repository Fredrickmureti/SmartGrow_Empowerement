-- ============================================================
-- Phase 4 closure (part 2): backfill + posting-path hardening
-- ============================================================

-- 1. Provision analytic accounts for projects that predate the trigger ----
--    A no-op UPDATE fires trg_projects_sync_analytic_account, which creates
--    exactly one account per project and never duplicates an existing one.
UPDATE public.projects
   SET updated_at = updated_at
 WHERE analytic_account_id IS NULL
   AND business_id IS NOT NULL
   AND organization_id IS NOT NULL
   AND COALESCE(is_template, false) = false;

-- 2. Backfill producer lines tagged with a project but no analytic account
UPDATE public.bill_items bi
   SET analytic_account_id = public.project_analytic_account_id(bi.project_id)
 WHERE bi.project_id IS NOT NULL
   AND bi.analytic_account_id IS NULL
   AND public.project_analytic_account_id(bi.project_id) IS NOT NULL;

UPDATE public.invoice_items ii
   SET analytic_account_id = public.project_analytic_account_id(ii.project_id)
 WHERE ii.project_id IS NOT NULL
   AND ii.analytic_account_id IS NULL
   AND public.project_analytic_account_id(ii.project_id) IS NOT NULL;

UPDATE public.expenses e
   SET analytic_account_id = public.project_analytic_account_id(e.project_id)
 WHERE e.project_id IS NOT NULL
   AND e.analytic_account_id IS NULL
   AND public.project_analytic_account_id(e.project_id) IS NOT NULL;

-- 3. Posting paths resolve project -> analytic account as a last resort ---
DO $do$
DECLARE
  v_def text;
  v_old text;
  v_new text;
BEGIN
  -- confirm_bill_atomic
  SELECT pg_get_functiondef(p.oid) INTO v_def
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'confirm_bill_atomic';

  v_old := 'bi.analytic_account_id AS analytic_account_id';
  v_new := 'COALESCE(bi.analytic_account_id, public.project_analytic_account_id(bi.project_id)) AS analytic_account_id';

  IF v_def IS NULL OR position(v_old in v_def) = 0 THEN
    RAISE EXCEPTION 'confirm_bill_atomic no longer exposes the expected analytic grouping key; review manually';
  END IF;
  EXECUTE replace(v_def, v_old, v_new);

  -- build_invoice_je_lines
  SELECT pg_get_functiondef(p.oid) INTO v_def
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'build_invoice_je_lines';

  v_old := 'ii.analytic_account_id AS analytic_account_id';
  v_new := 'COALESCE(ii.analytic_account_id, public.project_analytic_account_id(ii.project_id)) AS analytic_account_id';

  IF v_def IS NULL OR position(v_old in v_def) = 0 THEN
    RAISE EXCEPTION 'build_invoice_je_lines no longer exposes the expected analytic grouping key; review manually';
  END IF;
  EXECUTE replace(v_def, v_old, v_new);
END
$do$;