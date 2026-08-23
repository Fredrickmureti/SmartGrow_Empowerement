-- =====================================================================
-- PHASE 0 + 2: Analytic domain — security, integrity and model correction
-- =====================================================================

-- ---------- analytic_plans (the axis; previously an enum column) ------
CREATE TABLE IF NOT EXISTS public.analytic_plans (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  business_id uuid NOT NULL REFERENCES public.businesses(id) ON DELETE RESTRICT,
  code text NOT NULL,
  name text NOT NULL,
  description text,
  is_required boolean NOT NULL DEFAULT false,
  is_active boolean NOT NULL DEFAULT true,
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT analytic_plans_code_per_business UNIQUE (business_id, code)
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.analytic_plans TO authenticated;
GRANT ALL ON public.analytic_plans TO service_role;
ALTER TABLE public.analytic_plans ENABLE ROW LEVEL SECURITY;

DROP TRIGGER IF EXISTS update_analytic_plans_timestamp ON public.analytic_plans;
CREATE TRIGGER update_analytic_plans_timestamp
  BEFORE UPDATE ON public.analytic_plans
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- Seed the four axes the product already exposed, per company.
INSERT INTO public.analytic_plans (organization_id, business_id, code, name, sort_order)
SELECT b.organization_id, b.id, p.code, p.name, p.sort_order
  FROM public.businesses b
  CROSS JOIN (VALUES
    ('cost_center',  'Cost Center',  10),
    ('department',   'Department',   20),
    ('project',      'Project',      30),
    ('product_line', 'Product Line', 40)
  ) AS p(code, name, sort_order)
ON CONFLICT (business_id, code) DO NOTHING;

-- ---------- analytic_accounts: plan, lifecycle, no fake balance -------
ALTER TABLE public.analytic_accounts
  ADD COLUMN IF NOT EXISTS plan_id uuid REFERENCES public.analytic_plans(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS parent_id uuid REFERENCES public.analytic_accounts(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'active';

-- Map any pre-existing rows onto their plan before enforcing NOT NULL.
UPDATE public.analytic_accounts aa
   SET plan_id = ap.id
  FROM public.analytic_plans ap
 WHERE aa.plan_id IS NULL
   AND ap.business_id = aa.business_id
   AND ap.code = COALESCE(aa.analytic_type, 'cost_center');

ALTER TABLE public.analytic_accounts
  ALTER COLUMN plan_id SET NOT NULL;

ALTER TABLE public.analytic_accounts
  DROP CONSTRAINT IF EXISTS analytic_accounts_status_check;
ALTER TABLE public.analytic_accounts
  ADD CONSTRAINT analytic_accounts_status_check
  CHECK (status IN ('draft', 'active', 'restricted', 'archived'));

-- `balance` was rendered in the UI but never maintained by any writer.
ALTER TABLE public.analytic_accounts DROP COLUMN IF EXISTS balance;
-- The axis is now data (plan_id), not an enum.
ALTER TABLE public.analytic_accounts DROP COLUMN IF EXISTS analytic_type;

-- Code uniqueness belongs at the company grain, not the organization.
ALTER TABLE public.analytic_accounts
  DROP CONSTRAINT IF EXISTS analytic_accounts_organization_id_code_key;
CREATE UNIQUE INDEX IF NOT EXISTS analytic_accounts_code_per_business
  ON public.analytic_accounts (business_id, code) WHERE code IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_analytic_accounts_plan
  ON public.analytic_accounts (business_id, plan_id);

-- A plan and an account must belong to the same company.
CREATE OR REPLACE FUNCTION public._analytic_account_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_plan_business uuid;
BEGIN
  SELECT business_id INTO v_plan_business FROM public.analytic_plans WHERE id = NEW.plan_id;
  IF v_plan_business IS NULL OR v_plan_business <> NEW.business_id THEN
    RAISE EXCEPTION 'Analytic plan % does not belong to company %', NEW.plan_id, NEW.business_id
      USING ERRCODE = '23514';
  END IF;

  IF TG_OP = 'UPDATE' AND (NEW.plan_id <> OLD.plan_id OR NEW.business_id <> OLD.business_id) THEN
    IF EXISTS (SELECT 1 FROM public.journal_entry_lines l WHERE l.analytic_account_id = OLD.id) THEN
      RAISE EXCEPTION 'Analytic account % is already attributed on posted entries; its plan and company are immutable', OLD.id
        USING ERRCODE = '23514';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_analytic_account_guard ON public.analytic_accounts;
CREATE TRIGGER trg_analytic_account_guard
  BEFORE INSERT OR UPDATE ON public.analytic_accounts
  FOR EACH ROW EXECUTE FUNCTION public._analytic_account_guard();

-- Deleting master data that carries posted meaning destroys history.
CREATE OR REPLACE FUNCTION public._analytic_account_delete_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.journal_entry_lines l WHERE l.analytic_account_id = OLD.id) THEN
    RAISE EXCEPTION 'Analytic account % is referenced by posted journal lines — archive it instead of deleting', OLD.id
      USING ERRCODE = '23503';
  END IF;
  RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS trg_analytic_account_delete_guard ON public.analytic_accounts;
CREATE TRIGGER trg_analytic_account_delete_guard
  BEFORE DELETE ON public.analytic_accounts
  FOR EACH ROW EXECUTE FUNCTION public._analytic_account_delete_guard();

-- Posted attribution must never cascade away with its master row.
ALTER TABLE public.analytic_distributions
  DROP CONSTRAINT IF EXISTS analytic_distributions_analytic_account_id_fkey;
ALTER TABLE public.analytic_distributions
  ADD CONSTRAINT analytic_distributions_analytic_account_id_fkey
  FOREIGN KEY (analytic_account_id) REFERENCES public.analytic_accounts(id) ON DELETE RESTRICT;

-- ---------- RLS: company scoped, permission aware ---------------------
DROP POLICY IF EXISTS analytic_accounts_select ON public.analytic_accounts;
DROP POLICY IF EXISTS analytic_accounts_insert ON public.analytic_accounts;
DROP POLICY IF EXISTS analytic_accounts_update ON public.analytic_accounts;
DROP POLICY IF EXISTS analytic_accounts_delete ON public.analytic_accounts;

CREATE POLICY analytic_accounts_select_v2 ON public.analytic_accounts
  FOR SELECT TO authenticated
  USING (public.user_can_access_business(auth.uid(), business_id)
         AND public.user_has_module_permission(auth.uid(), organization_id, business_id, 'financials', 'read'));

CREATE POLICY analytic_accounts_insert_v2 ON public.analytic_accounts
  FOR INSERT TO authenticated
  WITH CHECK (public.user_can_access_business(auth.uid(), business_id)
              AND public.has_finance_permission(auth.uid(), 'finance.manage_coa', business_id));

CREATE POLICY analytic_accounts_update_v2 ON public.analytic_accounts
  FOR UPDATE TO authenticated
  USING (public.user_can_access_business(auth.uid(), business_id)
         AND public.has_finance_permission(auth.uid(), 'finance.manage_coa', business_id))
  WITH CHECK (public.user_can_access_business(auth.uid(), business_id)
              AND public.has_finance_permission(auth.uid(), 'finance.manage_coa', business_id));

CREATE POLICY analytic_accounts_delete_v2 ON public.analytic_accounts
  FOR DELETE TO authenticated
  USING (public.user_can_access_business(auth.uid(), business_id)
         AND public.has_finance_permission(auth.uid(), 'finance.manage_coa', business_id));

DROP POLICY IF EXISTS analytic_groups_select ON public.analytic_groups;
DROP POLICY IF EXISTS analytic_groups_insert ON public.analytic_groups;
DROP POLICY IF EXISTS analytic_groups_update ON public.analytic_groups;
DROP POLICY IF EXISTS analytic_groups_delete ON public.analytic_groups;

CREATE POLICY analytic_groups_select_v2 ON public.analytic_groups
  FOR SELECT TO authenticated
  USING (public.user_can_access_business(auth.uid(), business_id)
         AND public.user_has_module_permission(auth.uid(), organization_id, business_id, 'financials', 'read'));

CREATE POLICY analytic_groups_insert_v2 ON public.analytic_groups
  FOR INSERT TO authenticated
  WITH CHECK (public.user_can_access_business(auth.uid(), business_id)
              AND public.has_finance_permission(auth.uid(), 'finance.manage_coa', business_id));

CREATE POLICY analytic_groups_update_v2 ON public.analytic_groups
  FOR UPDATE TO authenticated
  USING (public.user_can_access_business(auth.uid(), business_id)
         AND public.has_finance_permission(auth.uid(), 'finance.manage_coa', business_id))
  WITH CHECK (public.user_can_access_business(auth.uid(), business_id)
              AND public.has_finance_permission(auth.uid(), 'finance.manage_coa', business_id));

CREATE POLICY analytic_groups_delete_v2 ON public.analytic_groups
  FOR DELETE TO authenticated
  USING (public.user_can_access_business(auth.uid(), business_id)
         AND public.has_finance_permission(auth.uid(), 'finance.manage_coa', business_id));

CREATE POLICY analytic_plans_select ON public.analytic_plans
  FOR SELECT TO authenticated
  USING (public.user_can_access_business(auth.uid(), business_id)
         AND public.user_has_module_permission(auth.uid(), organization_id, business_id, 'financials', 'read'));

CREATE POLICY analytic_plans_insert ON public.analytic_plans
  FOR INSERT TO authenticated
  WITH CHECK (public.user_can_access_business(auth.uid(), business_id)
              AND public.has_finance_permission(auth.uid(), 'finance.manage_coa', business_id));

CREATE POLICY analytic_plans_update ON public.analytic_plans
  FOR UPDATE TO authenticated
  USING (public.user_can_access_business(auth.uid(), business_id)
         AND public.has_finance_permission(auth.uid(), 'finance.manage_coa', business_id))
  WITH CHECK (public.user_can_access_business(auth.uid(), business_id)
              AND public.has_finance_permission(auth.uid(), 'finance.manage_coa', business_id));

CREATE POLICY analytic_plans_delete ON public.analytic_plans
  FOR DELETE TO authenticated
  USING (public.user_can_access_business(auth.uid(), business_id)
         AND public.has_finance_permission(auth.uid(), 'finance.manage_coa', business_id));

-- Distributions are posted financial data: readable per company, never
-- writable from the client. Only SECURITY DEFINER posting routines write.
DROP POLICY IF EXISTS analytic_distributions_select ON public.analytic_distributions;
DROP POLICY IF EXISTS analytic_distributions_insert ON public.analytic_distributions;
DROP POLICY IF EXISTS analytic_distributions_update ON public.analytic_distributions;
DROP POLICY IF EXISTS analytic_distributions_delete ON public.analytic_distributions;

REVOKE INSERT, UPDATE, DELETE ON public.analytic_distributions FROM authenticated;

CREATE POLICY analytic_distributions_select_v2 ON public.analytic_distributions
  FOR SELECT TO authenticated
  USING (public.user_can_access_business(auth.uid(), business_id)
         AND public.user_has_module_permission(auth.uid(), organization_id, business_id, 'financials', 'read'));