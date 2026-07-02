
-- =========================================================================
-- PROJECTS APP — STAGE 2: ANALYTIC LEDGER TRIGGERS + PROFITABILITY RPC
-- =========================================================================

-- ---------- Helper: get employee hourly cost ------------------------------
CREATE OR REPLACE FUNCTION public.project_employee_cost_rate(_employee_id uuid, _project_id uuid)
RETURNS numeric
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT COALESCE(
    (SELECT NULLIF(basic_salary,0) / 173.0 FROM public.employees WHERE id = _employee_id),
    (SELECT NULLIF(hourly_rate,0)          FROM public.projects  WHERE id = _project_id),
    0
  );
$$;

-- ---------- Helpers: upsert / delete ledger rows --------------------------
CREATE OR REPLACE FUNCTION public.upsert_project_cost(
  _project_id uuid, _organization_id uuid, _business_id uuid, _task_id uuid,
  _source_type text, _source_id uuid, _employee_id uuid,
  _hours numeric, _amount numeric, _currency text, _posted_at timestamptz, _description text
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  INSERT INTO public.project_cost_entries
    (project_id, organization_id, business_id, task_id, source_type, source_id,
     employee_id, hours, amount, currency, posted_at, description)
  VALUES (_project_id, _organization_id, _business_id, _task_id, _source_type, _source_id,
          _employee_id, _hours, _amount, COALESCE(_currency,'USD'), COALESCE(_posted_at, now()), _description)
  ON CONFLICT (source_type, source_id) WHERE source_id IS NOT NULL AND source_type <> 'manual'
  DO UPDATE SET
    project_id      = EXCLUDED.project_id,
    organization_id = EXCLUDED.organization_id,
    business_id     = EXCLUDED.business_id,
    task_id         = EXCLUDED.task_id,
    employee_id     = EXCLUDED.employee_id,
    hours           = EXCLUDED.hours,
    amount          = EXCLUDED.amount,
    currency        = EXCLUDED.currency,
    posted_at       = EXCLUDED.posted_at,
    description     = EXCLUDED.description;
END; $$;

CREATE OR REPLACE FUNCTION public.upsert_project_revenue(
  _project_id uuid, _organization_id uuid, _business_id uuid,
  _source_type text, _source_id uuid, _milestone_id uuid,
  _amount numeric, _currency text, _posted_at timestamptz, _description text
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  INSERT INTO public.project_revenue_entries
    (project_id, organization_id, business_id, source_type, source_id, milestone_id,
     amount, currency, posted_at, description)
  VALUES (_project_id, _organization_id, _business_id, _source_type, _source_id, _milestone_id,
          _amount, COALESCE(_currency,'USD'), COALESCE(_posted_at, now()), _description)
  ON CONFLICT (source_type, source_id) WHERE source_id IS NOT NULL AND source_type <> 'manual'
  DO UPDATE SET
    project_id      = EXCLUDED.project_id,
    organization_id = EXCLUDED.organization_id,
    business_id     = EXCLUDED.business_id,
    milestone_id    = EXCLUDED.milestone_id,
    amount          = EXCLUDED.amount,
    currency        = EXCLUDED.currency,
    posted_at       = EXCLUDED.posted_at,
    description     = EXCLUDED.description;
END; $$;

-- ---------- Trigger: timesheets -> project_cost_entries -------------------
CREATE OR REPLACE FUNCTION public.trg_timesheet_to_cost()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_rate numeric; v_amount numeric;
BEGIN
  IF TG_OP = 'DELETE' THEN
    DELETE FROM public.project_cost_entries
      WHERE source_type='timesheet' AND source_id = OLD.id;
    RETURN OLD;
  END IF;

  IF NEW.project_id IS NULL OR NEW.status <> 'approved' THEN
    DELETE FROM public.project_cost_entries
      WHERE source_type='timesheet' AND source_id = NEW.id;
    RETURN NEW;
  END IF;

  v_rate   := public.project_employee_cost_rate(NEW.employee_id, NEW.project_id);
  v_amount := COALESCE(NEW.hours,0) * COALESCE(v_rate,0);

  PERFORM public.upsert_project_cost(
    NEW.project_id, NEW.organization_id, NEW.business_id, NEW.task_id,
    'timesheet', NEW.id, NEW.employee_id,
    NEW.hours, v_amount, NULL, COALESCE(NEW.approved_at, NEW.date::timestamptz),
    'Timesheet labour cost'
  );
  RETURN NEW;
END; $$;

DROP TRIGGER IF EXISTS trg_timesheets_cost ON public.timesheets;
CREATE TRIGGER trg_timesheets_cost
  AFTER INSERT OR UPDATE OR DELETE ON public.timesheets
  FOR EACH ROW EXECUTE FUNCTION public.trg_timesheet_to_cost();

-- ---------- Trigger: expenses -> project_cost_entries ---------------------
CREATE OR REPLACE FUNCTION public.trg_expense_to_cost()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    DELETE FROM public.project_cost_entries
      WHERE source_type='expense' AND source_id = OLD.id;
    RETURN OLD;
  END IF;

  IF NEW.project_id IS NULL OR NEW.status NOT IN ('approved','paid') THEN
    DELETE FROM public.project_cost_entries
      WHERE source_type='expense' AND source_id = NEW.id;
    RETURN NEW;
  END IF;

  PERFORM public.upsert_project_cost(
    NEW.project_id, NEW.organization_id, NEW.business_id, NEW.task_id,
    'expense', NEW.id, NULL,
    NULL, COALESCE(NEW.amount,0), NEW.currency, NEW.created_at,
    'Expense'
  );
  RETURN NEW;
END; $$;

DROP TRIGGER IF EXISTS trg_expenses_cost ON public.expenses;
CREATE TRIGGER trg_expenses_cost
  AFTER INSERT OR UPDATE OR DELETE ON public.expenses
  FOR EACH ROW EXECUTE FUNCTION public.trg_expense_to_cost();

-- ---------- Trigger: bills -> project_cost_entries ------------------------
CREATE OR REPLACE FUNCTION public.trg_bill_to_cost()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    DELETE FROM public.project_cost_entries
      WHERE source_type='vendor_bill' AND source_id = OLD.id;
    RETURN OLD;
  END IF;

  IF NEW.project_id IS NULL OR NEW.status::text NOT IN ('received','partial','paid','overdue') THEN
    DELETE FROM public.project_cost_entries
      WHERE source_type='vendor_bill' AND source_id = NEW.id;
    RETURN NEW;
  END IF;

  PERFORM public.upsert_project_cost(
    NEW.project_id, NEW.organization_id, NEW.business_id, NEW.task_id,
    'vendor_bill', NEW.id, NULL,
    NULL, COALESCE(NEW.total, NEW.subtotal, 0), NEW.currency, NEW.created_at,
    'Vendor bill'
  );
  RETURN NEW;
END; $$;

DROP TRIGGER IF EXISTS trg_bills_cost ON public.bills;
CREATE TRIGGER trg_bills_cost
  AFTER INSERT OR UPDATE OR DELETE ON public.bills
  FOR EACH ROW EXECUTE FUNCTION public.trg_bill_to_cost();

-- ---------- Trigger: invoices -> project_revenue_entries -----------------
CREATE OR REPLACE FUNCTION public.trg_invoice_to_revenue()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    DELETE FROM public.project_revenue_entries
      WHERE source_type='invoice' AND source_id = OLD.id;
    RETURN OLD;
  END IF;

  IF NEW.project_id IS NULL OR NEW.status::text NOT IN ('sent','viewed','partial','paid','confirmed','overdue') THEN
    DELETE FROM public.project_revenue_entries
      WHERE source_type='invoice' AND source_id = NEW.id;
    RETURN NEW;
  END IF;

  PERFORM public.upsert_project_revenue(
    NEW.project_id, NEW.organization_id, NEW.business_id,
    'invoice', NEW.id, NULL,
    COALESCE(NEW.total, NEW.subtotal, 0), NEW.currency, NEW.created_at,
    'Customer invoice'
  );
  RETURN NEW;
END; $$;

DROP TRIGGER IF EXISTS trg_invoices_revenue ON public.invoices;
CREATE TRIGGER trg_invoices_revenue
  AFTER INSERT OR UPDATE OR DELETE ON public.invoices
  FOR EACH ROW EXECUTE FUNCTION public.trg_invoice_to_revenue();

-- ---------- Trigger: milestone reached -> project_revenue_entries ---------
-- Only when the project is milestone-billed AND the milestone has a billing amount.
ALTER TABLE public.project_milestones
  ADD COLUMN IF NOT EXISTS billing_amount numeric;

CREATE OR REPLACE FUNCTION public.trg_milestone_to_revenue()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_proj public.projects%ROWTYPE;
BEGIN
  IF TG_OP = 'DELETE' THEN
    DELETE FROM public.project_revenue_entries
      WHERE source_type='milestone' AND source_id = OLD.id;
    RETURN OLD;
  END IF;

  SELECT * INTO v_proj FROM public.projects WHERE id = NEW.project_id;
  IF v_proj.id IS NULL OR v_proj.pricing_type <> 'milestone' OR NEW.is_reached IS NOT TRUE OR COALESCE(NEW.billing_amount,0) = 0 THEN
    DELETE FROM public.project_revenue_entries
      WHERE source_type='milestone' AND source_id = NEW.id;
    RETURN NEW;
  END IF;

  PERFORM public.upsert_project_revenue(
    v_proj.id, v_proj.organization_id, v_proj.business_id,
    'milestone', NEW.id, NEW.id,
    NEW.billing_amount, v_proj.currency, COALESCE(NEW.reached_at, now()),
    'Milestone billed: ' || NEW.name
  );
  RETURN NEW;
END; $$;

DROP TRIGGER IF EXISTS trg_milestones_revenue ON public.project_milestones;
CREATE TRIGGER trg_milestones_revenue
  AFTER INSERT OR UPDATE OR DELETE ON public.project_milestones
  FOR EACH ROW EXECUTE FUNCTION public.trg_milestone_to_revenue();

-- ---------- Profitability RPC --------------------------------------------
CREATE OR REPLACE FUNCTION public.compute_project_profitability(_project_id uuid)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_proj public.projects%ROWTYPE;
  v_cost numeric := 0;
  v_revenue numeric := 0;
  v_planned_hours numeric := 0;
  v_logged_hours numeric := 0;
  v_cost_breakdown jsonb;
  v_revenue_breakdown jsonb;
BEGIN
  SELECT * INTO v_proj FROM public.projects WHERE id = _project_id;
  IF v_proj.id IS NULL THEN
    RAISE EXCEPTION 'Project % not found', _project_id;
  END IF;

  -- Authorization: rely on can_access_project for the calling user
  IF NOT public.can_access_project(_project_id, auth.uid()) THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;

  SELECT COALESCE(SUM(amount),0) INTO v_cost
    FROM public.project_cost_entries WHERE project_id = _project_id;

  SELECT COALESCE(SUM(amount),0) INTO v_revenue
    FROM public.project_revenue_entries WHERE project_id = _project_id;

  SELECT COALESCE(SUM(planned_hours),0), COALESCE(SUM(effective_hours),0)
    INTO v_planned_hours, v_logged_hours
    FROM public.project_tasks
    WHERE project_id = _project_id AND COALESCE(is_active,true) = true;

  SELECT jsonb_object_agg(source_type, total) INTO v_cost_breakdown
    FROM (
      SELECT source_type, SUM(amount) AS total
      FROM public.project_cost_entries
      WHERE project_id = _project_id
      GROUP BY source_type
    ) c;

  SELECT jsonb_object_agg(source_type, total) INTO v_revenue_breakdown
    FROM (
      SELECT source_type, SUM(amount) AS total
      FROM public.project_revenue_entries
      WHERE project_id = _project_id
      GROUP BY source_type
    ) r;

  RETURN jsonb_build_object(
    'project_id',       _project_id,
    'currency',         COALESCE(v_proj.currency,'USD'),
    'cost_total',       v_cost,
    'revenue_total',    v_revenue,
    'margin',           v_revenue - v_cost,
    'margin_pct',       CASE WHEN v_revenue = 0 THEN NULL ELSE round(((v_revenue - v_cost) / v_revenue) * 100, 2) END,
    'planned_hours',    v_planned_hours,
    'logged_hours',     v_logged_hours,
    'budget',           v_proj.budget,
    'budget_used_pct',  CASE WHEN COALESCE(v_proj.budget,0) = 0 THEN NULL ELSE round((v_cost / v_proj.budget) * 100, 2) END,
    'cost_by_source',   COALESCE(v_cost_breakdown, '{}'::jsonb),
    'revenue_by_source',COALESCE(v_revenue_breakdown, '{}'::jsonb)
  );
END; $$;

GRANT EXECUTE ON FUNCTION public.compute_project_profitability(uuid) TO authenticated;

-- ---------- Backfill existing rows ---------------------------------------
-- Timesheets
INSERT INTO public.project_cost_entries
  (project_id, organization_id, business_id, task_id, source_type, source_id,
   employee_id, hours, amount, currency, posted_at, description)
SELECT t.project_id, t.organization_id, t.business_id, t.task_id, 'timesheet', t.id,
       t.employee_id, t.hours,
       COALESCE(t.hours,0) * public.project_employee_cost_rate(t.employee_id, t.project_id),
       'USD',
       COALESCE(t.approved_at, t.date::timestamptz),
       'Timesheet labour cost'
  FROM public.timesheets t
 WHERE t.project_id IS NOT NULL AND t.status = 'approved'
ON CONFLICT (source_type, source_id) WHERE source_id IS NOT NULL AND source_type <> 'manual' DO NOTHING;

-- Expenses
INSERT INTO public.project_cost_entries
  (project_id, organization_id, business_id, task_id, source_type, source_id,
   employee_id, hours, amount, currency, posted_at, description)
SELECT e.project_id, e.organization_id, e.business_id, e.task_id, 'expense', e.id,
       NULL, NULL, COALESCE(e.amount,0), e.currency, e.created_at, 'Expense'
  FROM public.expenses e
 WHERE e.project_id IS NOT NULL AND e.status::text IN ('approved','paid')
ON CONFLICT (source_type, source_id) WHERE source_id IS NOT NULL AND source_type <> 'manual' DO NOTHING;

-- Bills
INSERT INTO public.project_cost_entries
  (project_id, organization_id, business_id, task_id, source_type, source_id,
   employee_id, hours, amount, currency, posted_at, description)
SELECT b.project_id, b.organization_id, b.business_id, b.task_id, 'vendor_bill', b.id,
       NULL, NULL, COALESCE(b.total, b.subtotal, 0), b.currency, b.created_at, 'Vendor bill'
  FROM public.bills b
 WHERE b.project_id IS NOT NULL AND b.status::text IN ('received','partial','paid','overdue')
ON CONFLICT (source_type, source_id) WHERE source_id IS NOT NULL AND source_type <> 'manual' DO NOTHING;

-- Invoices
INSERT INTO public.project_revenue_entries
  (project_id, organization_id, business_id, source_type, source_id, milestone_id,
   amount, currency, posted_at, description)
SELECT i.project_id, i.organization_id, i.business_id, 'invoice', i.id, NULL,
       COALESCE(i.total, i.subtotal, 0), i.currency, i.created_at, 'Customer invoice'
  FROM public.invoices i
 WHERE i.project_id IS NOT NULL
   AND i.status::text IN ('sent','viewed','partial','paid','confirmed','overdue')
ON CONFLICT (source_type, source_id) WHERE source_id IS NOT NULL AND source_type <> 'manual' DO NOTHING;
