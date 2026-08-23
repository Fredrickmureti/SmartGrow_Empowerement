-- ============================================================
-- Phase 4 closure: project attribution reaches the GL analytic ledger
-- ============================================================

-- 1. Bind projects to the analytic ledger -------------------------------
ALTER TABLE public.projects
  ADD COLUMN IF NOT EXISTS analytic_account_id uuid REFERENCES public.analytic_accounts(id) ON DELETE RESTRICT;

CREATE INDEX IF NOT EXISTS idx_projects_analytic_account
  ON public.projects(analytic_account_id) WHERE analytic_account_id IS NOT NULL;

-- 2. Resolver used by every producer ------------------------------------
CREATE OR REPLACE FUNCTION public.project_analytic_account_id(p_project_id uuid)
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT p.analytic_account_id
    FROM public.projects p
    JOIN public.analytic_accounts aa ON aa.id = p.analytic_account_id
   WHERE p.id = p_project_id
     AND aa.status = 'active';
$$;

-- 3. Auto-provision one analytic account per project --------------------
CREATE OR REPLACE FUNCTION public._project_sync_analytic_account()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_plan_id uuid;
  v_code text;
  v_status text;
BEGIN
  IF NEW.business_id IS NULL OR NEW.organization_id IS NULL THEN
    RETURN NEW;
  END IF;

  -- Templates are not cost objects.
  IF COALESCE(NEW.is_template, false) THEN
    RETURN NEW;
  END IF;

  SELECT id INTO v_plan_id
    FROM public.analytic_plans
   WHERE business_id = NEW.business_id AND code = 'project'
   LIMIT 1;

  IF v_plan_id IS NULL THEN
    INSERT INTO public.analytic_plans (organization_id, business_id, code, name, description, is_required, is_active, sort_order)
    VALUES (NEW.organization_id, NEW.business_id, 'project', 'Project',
            'One analytic account per project. Provisioned automatically.', false, true, 40)
    RETURNING id INTO v_plan_id;
  END IF;

  v_code := 'PRJ-' || COALESCE(NULLIF(NEW.project_number, ''), left(NEW.id::text, 8));
  v_status := CASE
    WHEN COALESCE(NEW.is_active, true) = false THEN 'archived'
    WHEN COALESCE(NEW.status, 'active') IN ('completed', 'cancelled', 'closed', 'archived') THEN 'archived'
    ELSE 'active'
  END;

  IF NEW.analytic_account_id IS NULL THEN
    INSERT INTO public.analytic_accounts
      (organization_id, business_id, plan_id, code, name, description, status, is_active)
    VALUES
      (NEW.organization_id, NEW.business_id, v_plan_id, v_code, NEW.name,
       'Analytic account for project ' || COALESCE(NEW.project_number, NEW.name), v_status, v_status = 'active')
    RETURNING id INTO NEW.analytic_account_id;
  ELSE
    UPDATE public.analytic_accounts
       SET name = NEW.name,
           code = v_code,
           status = v_status,
           is_active = (v_status = 'active'),
           updated_at = now()
     WHERE id = NEW.analytic_account_id;
  END IF;

  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_projects_sync_analytic_account ON public.projects;
CREATE TRIGGER trg_projects_sync_analytic_account
  BEFORE INSERT OR UPDATE OF name, project_number, status, is_active, business_id, organization_id
  ON public.projects
  FOR EACH ROW EXECUTE FUNCTION public._project_sync_analytic_account();

-- 4. Producers: a project tag defaults the analytic attribution ---------
CREATE OR REPLACE FUNCTION public._default_analytic_from_project()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  IF NEW.analytic_account_id IS NULL AND NEW.project_id IS NOT NULL THEN
    NEW.analytic_account_id := public.project_analytic_account_id(NEW.project_id);
  END IF;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_bill_items_default_analytic ON public.bill_items;
CREATE TRIGGER trg_bill_items_default_analytic
  BEFORE INSERT OR UPDATE OF project_id, analytic_account_id ON public.bill_items
  FOR EACH ROW EXECUTE FUNCTION public._default_analytic_from_project();

DROP TRIGGER IF EXISTS trg_invoice_items_default_analytic ON public.invoice_items;
CREATE TRIGGER trg_invoice_items_default_analytic
  BEFORE INSERT OR UPDATE OF project_id, analytic_account_id ON public.invoice_items
  FOR EACH ROW EXECUTE FUNCTION public._default_analytic_from_project();

DROP TRIGGER IF EXISTS trg_expenses_default_analytic ON public.expenses;
CREATE TRIGGER trg_expenses_default_analytic
  BEFORE INSERT OR UPDATE OF project_id, analytic_account_id ON public.expenses
  FOR EACH ROW EXECUTE FUNCTION public._default_analytic_from_project();

-- 5. Expense posting: resolve by FK, not by free-text code --------------
DO $do$
DECLARE
  v_def text;
  v_old text := $old$  IF v_analytic IS NULL AND v_exp.project_id IS NOT NULL THEN
    SELECT aa.id INTO v_analytic
      FROM public.projects p
      JOIN public.analytic_accounts aa
        ON aa.business_id = p.business_id
       AND aa.code = p.analytic_account_code
     WHERE p.id = v_exp.project_id
       AND aa.status = 'active'
     LIMIT 1;
  END IF;$old$;
  v_new text := $new$  IF v_analytic IS NULL AND v_exp.project_id IS NOT NULL THEN
    v_analytic := public.project_analytic_account_id(v_exp.project_id);
  END IF;$new$;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'post_expense_gl';

  IF v_def IS NULL OR position(v_old in v_def) = 0 THEN
    RAISE EXCEPTION 'post_expense_gl no longer contains the expected project analytic block; review manually';
  END IF;

  EXECUTE replace(v_def, v_old, v_new);
END
$do$;

-- The free-text code is now dead: nothing reads it.
ALTER TABLE public.projects DROP COLUMN IF EXISTS analytic_account_code;

-- 6. Reconciliation: GL analytic ledger vs operational project ledger ---
CREATE OR REPLACE FUNCTION public.project_analytic_reconciliation(
  p_business_id uuid,
  p_date_from date,
  p_date_to date
)
RETURNS TABLE(
  project_id uuid,
  project_number text,
  project_name text,
  analytic_account_id uuid,
  gl_analytic_net numeric,
  project_ledger_cost numeric,
  project_ledger_revenue numeric,
  project_ledger_net numeric,
  difference numeric
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT p.id,
         p.project_number,
         p.name,
         p.analytic_account_id,
         COALESCE(gl.net, 0),
         COALESCE(c.cost, 0),
         COALESCE(r.revenue, 0),
         COALESCE(c.cost, 0) - COALESCE(r.revenue, 0),
         COALESCE(gl.net, 0) - (COALESCE(c.cost, 0) - COALESCE(r.revenue, 0))
    FROM public.projects p
    LEFT JOIN LATERAL (
      SELECT SUM(a.amount) AS net
        FROM public.journal_entry_line_analytics a
        JOIN public.journal_entries je ON je.id = a.journal_entry_id
       WHERE a.analytic_account_id = p.analytic_account_id
         AND a.entry_date BETWEEN p_date_from AND p_date_to
         AND je.status IN ('posted', 'reversed')
    ) gl ON true
    LEFT JOIN LATERAL (
      SELECT SUM(pc.amount) AS cost
        FROM public.project_cost_entries pc
       WHERE pc.project_id = p.id
         AND pc.posted_at::date BETWEEN p_date_from AND p_date_to
    ) c ON true
    LEFT JOIN LATERAL (
      SELECT SUM(pr.amount) AS revenue
        FROM public.project_revenue_entries pr
       WHERE pr.project_id = p.id
         AND pr.posted_at::date BETWEEN p_date_from AND p_date_to
    ) r ON true
   WHERE p.business_id = p_business_id
     AND public.user_can_access_business(auth.uid(), p_business_id)
     AND public.user_has_module_permission(auth.uid(), p.organization_id, p.business_id, 'financials', 'read')
   ORDER BY p.project_number NULLS LAST, p.name;
$$;

GRANT EXECUTE ON FUNCTION public.project_analytic_reconciliation(uuid, date, date) TO authenticated;
GRANT EXECUTE ON FUNCTION public.project_analytic_account_id(uuid) TO authenticated;