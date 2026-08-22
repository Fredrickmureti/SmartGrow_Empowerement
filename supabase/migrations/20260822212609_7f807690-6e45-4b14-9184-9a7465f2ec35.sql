-- ============================================================
-- Phase 1: Budget domain model correction
-- ============================================================

-- ---------- 1. Lifecycle as an enum ----------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'budget_status') THEN
    CREATE TYPE public.budget_status AS ENUM ('draft', 'active', 'closed');
  END IF;
END $$;

ALTER TABLE public.budgets DROP CONSTRAINT IF EXISTS budgets_status_check;
ALTER TABLE public.budgets
  ALTER COLUMN status DROP DEFAULT,
  ALTER COLUMN status TYPE public.budget_status USING status::public.budget_status,
  ALTER COLUMN status SET DEFAULT 'draft'::public.budget_status;

-- ---------- 2. Currency identity ----------
ALTER TABLE public.budgets ADD COLUMN IF NOT EXISTS currency_code text;

UPDATE public.budgets b
SET currency_code = biz.base_currency
FROM public.businesses biz
WHERE biz.id = b.business_id AND b.currency_code IS NULL;

CREATE OR REPLACE FUNCTION public._budgets_defaults()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  IF NEW.currency_code IS NULL THEN
    SELECT base_currency INTO NEW.currency_code
    FROM public.businesses WHERE id = NEW.business_id;
  END IF;
  IF NEW.currency_code IS NULL THEN
    RAISE EXCEPTION 'Budget currency could not be resolved for business %', NEW.business_id;
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_budgets_defaults ON public.budgets;
CREATE TRIGGER trg_budgets_defaults
BEFORE INSERT OR UPDATE ON public.budgets
FOR EACH ROW EXECUTE FUNCTION public._budgets_defaults();

-- ---------- 3. Lifecycle transition guard ----------
CREATE OR REPLACE FUNCTION public._budgets_lifecycle_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status <> 'draft' THEN
      RAISE EXCEPTION 'Only draft budgets can be deleted. Close the budget instead.'
        USING ERRCODE = '23514';
    END IF;
    RETURN OLD;
  END IF;

  IF NEW.status <> OLD.status THEN
    IF NOT (
      (OLD.status = 'draft'  AND NEW.status IN ('active', 'closed')) OR
      (OLD.status = 'active' AND NEW.status = 'closed')
    ) THEN
      RAISE EXCEPTION 'Invalid budget status transition % -> %', OLD.status, NEW.status
        USING ERRCODE = '23514';
    END IF;
  END IF;

  IF OLD.status = 'closed' THEN
    RAISE EXCEPTION 'This budget is closed and can no longer be modified.'
      USING ERRCODE = '23514';
  END IF;

  IF OLD.business_id <> NEW.business_id
     OR OLD.organization_id <> NEW.organization_id
     OR COALESCE(OLD.branch_id::text, '') <> COALESCE(NEW.branch_id::text, '')
     OR OLD.fiscal_year <> NEW.fiscal_year THEN
    IF OLD.status <> 'draft' THEN
      RAISE EXCEPTION 'Scope and fiscal year of an activated budget cannot be changed.'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_budgets_lifecycle_guard ON public.budgets;
CREATE TRIGGER trg_budgets_lifecycle_guard
BEFORE UPDATE OR DELETE ON public.budgets
FOR EACH ROW EXECUTE FUNCTION public._budgets_lifecycle_guard();

-- ---------- 4. Budget lines: business + fiscal period identity ----------
ALTER TABLE public.budget_items
  ADD COLUMN IF NOT EXISTS business_id uuid,
  ADD COLUMN IF NOT EXISTS fiscal_period_id uuid;

ALTER TABLE public.budget_items
  DROP CONSTRAINT IF EXISTS budget_items_business_id_fkey,
  ADD CONSTRAINT budget_items_business_id_fkey
    FOREIGN KEY (business_id) REFERENCES public.businesses(id) ON DELETE RESTRICT;

ALTER TABLE public.budget_items
  DROP CONSTRAINT IF EXISTS budget_items_fiscal_period_id_fkey,
  ADD CONSTRAINT budget_items_fiscal_period_id_fkey
    FOREIGN KEY (fiscal_period_id) REFERENCES public.fiscal_periods(id) ON DELETE RESTRICT;

-- Account deletion must never silently destroy plan or actuals
ALTER TABLE public.budget_items
  DROP CONSTRAINT IF EXISTS budget_items_account_id_fkey,
  ADD CONSTRAINT budget_items_account_id_fkey
    FOREIGN KEY (account_id) REFERENCES public.accounts(id) ON DELETE RESTRICT;

ALTER TABLE public.budget_actuals
  DROP CONSTRAINT IF EXISTS budget_actuals_account_id_fkey,
  ADD CONSTRAINT budget_actuals_account_id_fkey
    FOREIGN KEY (account_id) REFERENCES public.accounts(id) ON DELETE RESTRICT;

-- Resolve + validate every budget line against the authoritative engines
CREATE OR REPLACE FUNCTION public._budget_items_normalize()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  b record;
  fp record;
  acct record;
  revising boolean;
BEGIN
  SELECT id, organization_id, business_id, fiscal_year, status
  INTO b
  FROM public.budgets
  WHERE id = COALESCE(NEW.budget_id, OLD.budget_id);

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Budget % not found', COALESCE(NEW.budget_id, OLD.budget_id);
  END IF;

  revising := COALESCE(current_setting('app.budget_revision', true), '') = b.id::text;

  IF b.status = 'closed' THEN
    RAISE EXCEPTION 'This budget is closed; its lines are read-only.' USING ERRCODE = '23514';
  END IF;

  IF b.status = 'active' AND NOT revising THEN
    RAISE EXCEPTION 'This budget is active. Record a budget revision instead of editing lines directly.'
      USING ERRCODE = '23514';
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;

  NEW.business_id := b.business_id;

  SELECT id, business_id, account_type INTO acct
  FROM public.accounts WHERE id = NEW.account_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Account % not found', NEW.account_id;
  END IF;
  IF acct.business_id <> b.business_id THEN
    RAISE EXCEPTION 'Account % belongs to a different business than this budget', NEW.account_id
      USING ERRCODE = '42501';
  END IF;

  IF NEW.fiscal_period_id IS NULL THEN
    SELECT id, start_date, status INTO fp
    FROM public.fiscal_periods
    WHERE business_id = b.business_id
      AND period_type = 'month'
      AND EXTRACT(YEAR FROM start_date)::int = b.fiscal_year
      AND EXTRACT(MONTH FROM start_date)::int = NEW.period_month
    ORDER BY start_date
    LIMIT 1;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'No monthly fiscal period exists for % / month % in this business. Provision fiscal periods first.',
        b.fiscal_year, NEW.period_month USING ERRCODE = '23503';
    END IF;
    NEW.fiscal_period_id := fp.id;
  ELSE
    SELECT id, start_date, status INTO fp
    FROM public.fiscal_periods
    WHERE id = NEW.fiscal_period_id AND business_id = b.business_id AND period_type = 'month';
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Fiscal period % does not belong to this budget''s business', NEW.fiscal_period_id
        USING ERRCODE = '42501';
    END IF;
  END IF;

  -- period_month / fiscal_year are derived display values
  NEW.period_month := EXTRACT(MONTH FROM fp.start_date)::int;

  IF fp.status <> 'open' THEN
    RAISE EXCEPTION 'Accounting period is % ; budget lines for it cannot be changed.', fp.status
      USING ERRCODE = '23514';
  END IF;

  IF NEW.budgeted_amount IS NULL OR NEW.budgeted_amount < 0 THEN
    RAISE EXCEPTION 'Budgeted amount must be zero or positive' USING ERRCODE = '23514';
  END IF;

  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_budget_items_normalize ON public.budget_items;
CREATE TRIGGER trg_budget_items_normalize
BEFORE INSERT OR UPDATE OR DELETE ON public.budget_items
FOR EACH ROW EXECUTE FUNCTION public._budget_items_normalize();

-- ---------- 5. Constraints and indexes ----------
CREATE UNIQUE INDEX IF NOT EXISTS budgets_scope_name_uniq
  ON public.budgets (business_id, COALESCE(branch_id, '00000000-0000-0000-0000-000000000000'::uuid), fiscal_year, lower(name));

CREATE UNIQUE INDEX IF NOT EXISTS budgets_single_active_per_scope
  ON public.budgets (business_id, COALESCE(branch_id, '00000000-0000-0000-0000-000000000000'::uuid), fiscal_year)
  WHERE status = 'active';

CREATE INDEX IF NOT EXISTS idx_budgets_business_year_status
  ON public.budgets (business_id, fiscal_year, status);
CREATE INDEX IF NOT EXISTS idx_budgets_branch ON public.budgets (branch_id);
CREATE INDEX IF NOT EXISTS idx_budget_items_budget_period
  ON public.budget_items (budget_id, fiscal_period_id);
CREATE INDEX IF NOT EXISTS idx_budget_items_business ON public.budget_items (business_id);
CREATE INDEX IF NOT EXISTS idx_budget_actuals_business ON public.budget_actuals (business_id);

-- ---------- 6. Revisions ----------
CREATE TABLE IF NOT EXISTS public.budget_revisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  budget_id uuid NOT NULL REFERENCES public.budgets(id) ON DELETE CASCADE,
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  business_id uuid NOT NULL REFERENCES public.businesses(id) ON DELETE RESTRICT,
  revision_number integer NOT NULL,
  reason text NOT NULL,
  note text,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (budget_id, revision_number)
);

CREATE TABLE IF NOT EXISTS public.budget_revision_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  revision_id uuid NOT NULL REFERENCES public.budget_revisions(id) ON DELETE CASCADE,
  account_id uuid NOT NULL REFERENCES public.accounts(id) ON DELETE RESTRICT,
  fiscal_period_id uuid NOT NULL REFERENCES public.fiscal_periods(id) ON DELETE RESTRICT,
  period_month integer NOT NULL CHECK (period_month BETWEEN 1 AND 12),
  previous_amount numeric NOT NULL DEFAULT 0,
  new_amount numeric NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (revision_id, account_id, fiscal_period_id)
);

CREATE INDEX IF NOT EXISTS idx_budget_revisions_budget ON public.budget_revisions (budget_id, revision_number DESC);
CREATE INDEX IF NOT EXISTS idx_budget_revision_lines_revision ON public.budget_revision_lines (revision_id);

GRANT SELECT ON public.budget_revisions TO authenticated;
GRANT ALL ON public.budget_revisions TO service_role;
GRANT SELECT ON public.budget_revision_lines TO authenticated;
GRANT ALL ON public.budget_revision_lines TO service_role;

ALTER TABLE public.budget_revisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.budget_revision_lines ENABLE ROW LEVEL SECURITY;

CREATE POLICY budget_revisions_select
ON public.budget_revisions
FOR SELECT
TO authenticated
USING (
  EXISTS (
    SELECT 1 FROM public.budgets b
    WHERE b.id = budget_revisions.budget_id
      AND public.user_can_access_business(auth.uid(), b.business_id)
      AND public.user_has_module_permission(auth.uid(), b.organization_id, b.business_id, 'financials', 'read')
      AND (
        b.branch_id IS NULL
        OR public.user_can_access_branch(auth.uid(), b.branch_id)
        OR public.has_finance_permission(auth.uid(), 'finance.view_consolidated', b.business_id)
      )
  )
);

CREATE POLICY budget_revision_lines_select
ON public.budget_revision_lines
FOR SELECT
TO authenticated
USING (
  EXISTS (
    SELECT 1
    FROM public.budget_revisions r
    JOIN public.budgets b ON b.id = r.budget_id
    WHERE r.id = budget_revision_lines.revision_id
      AND public.user_can_access_business(auth.uid(), b.business_id)
      AND public.user_has_module_permission(auth.uid(), b.organization_id, b.business_id, 'financials', 'read')
      AND (
        b.branch_id IS NULL
        OR public.user_can_access_branch(auth.uid(), b.branch_id)
        OR public.has_finance_permission(auth.uid(), 'finance.view_consolidated', b.business_id)
      )
  )
);

-- ---------- 7. Audit trail on budget lifecycle ----------
CREATE OR REPLACE FUNCTION public._budgets_audit()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_action text;
BEGIN
  IF TG_OP = 'INSERT' THEN
    v_action := 'budget.created';
  ELSIF TG_OP = 'DELETE' THEN
    v_action := 'budget.deleted';
  ELSIF NEW.status <> OLD.status THEN
    v_action := 'budget.' || NEW.status::text;
  ELSE
    v_action := 'budget.updated';
  END IF;

  INSERT INTO public.audit_logs (
    organization_id, business_id, user_id, action, entity_type, entity_id, entity_name,
    old_values, new_values
  ) VALUES (
    COALESCE(NEW.organization_id, OLD.organization_id),
    COALESCE(NEW.business_id, OLD.business_id),
    auth.uid(),
    v_action,
    'budget',
    COALESCE(NEW.id, OLD.id),
    COALESCE(NEW.name, OLD.name),
    CASE WHEN TG_OP = 'INSERT' THEN NULL ELSE to_jsonb(OLD) END,
    CASE WHEN TG_OP = 'DELETE' THEN NULL ELSE to_jsonb(NEW) END
  );

  RETURN COALESCE(NEW, OLD);
END;
$$;

DROP TRIGGER IF EXISTS trg_budgets_audit ON public.budgets;
CREATE TRIGGER trg_budgets_audit
AFTER INSERT OR UPDATE OR DELETE ON public.budgets
FOR EACH ROW EXECUTE FUNCTION public._budgets_audit();