
-- ─── Phase 3.1 — Run-Type Behavior Matrix ──────────────────────────────────
CREATE TABLE IF NOT EXISTS public.payroll_run_type_policies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  country_code text,                            -- NULL = global default
  run_type text NOT NULL,
  applies_recurring_earnings boolean NOT NULL DEFAULT true,
  applies_recurring_deductions boolean NOT NULL DEFAULT true,
  applies_statutory boolean NOT NULL DEFAULT true,
  applies_loan_installments boolean NOT NULL DEFAULT true,
  applies_garnishments boolean NOT NULL DEFAULT true,
  accrues_leave boolean NOT NULL DEFAULT true,
  accrues_benefits boolean NOT NULL DEFAULT true,
  tax_method text NOT NULL DEFAULT 'ordinary',
  population_source text NOT NULL DEFAULT 'active_in_period',
  requires_parent_run boolean NOT NULL DEFAULT false,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT payroll_run_type_policies_run_type_chk CHECK (
    run_type IN ('regular','off_cycle','supplemental','bonus','commission','13th_month','termination','correction')
  ),
  CONSTRAINT payroll_run_type_policies_tax_method_chk CHECK (
    tax_method IN ('ordinary','annualized','aggregate','separate_rate')
  ),
  CONSTRAINT payroll_run_type_policies_population_chk CHECK (
    population_source IN ('active_in_period','parent_run','explicit','terminating_in_period')
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS payroll_run_type_policies_global_unq
  ON public.payroll_run_type_policies (run_type)
  WHERE country_code IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS payroll_run_type_policies_country_unq
  ON public.payroll_run_type_policies (country_code, run_type)
  WHERE country_code IS NOT NULL;

GRANT SELECT ON public.payroll_run_type_policies TO authenticated;
GRANT ALL ON public.payroll_run_type_policies TO service_role;

ALTER TABLE public.payroll_run_type_policies ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS payroll_run_type_policies_read ON public.payroll_run_type_policies;
CREATE POLICY payroll_run_type_policies_read
  ON public.payroll_run_type_policies
  FOR SELECT
  TO authenticated
  USING (true);

DROP TRIGGER IF EXISTS payroll_run_type_policies_updated_at ON public.payroll_run_type_policies;
CREATE TRIGGER payroll_run_type_policies_updated_at
  BEFORE UPDATE ON public.payroll_run_type_policies
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- Audit envelope on payroll_runs — the resolved policy under which the run
-- was computed. Persisted on insert so re-preview / reverse-debug are exact.
ALTER TABLE public.payroll_runs
  ADD COLUMN IF NOT EXISTS run_type_policy_snapshot jsonb;

-- Resolver: country-specific row wins, else the global default. STABLE so it
-- can be inlined in the engine without surprise re-evaluation.
CREATE OR REPLACE FUNCTION public.payroll_get_run_type_policy(
  p_country_code text,
  p_run_type text
)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT to_jsonb(p)
  FROM public.payroll_run_type_policies p
  WHERE p.run_type = p_run_type
    AND (p.country_code = p_country_code OR p.country_code IS NULL)
  ORDER BY (p.country_code IS NULL)  -- false (specific) before true (default)
  LIMIT 1
$$;

GRANT EXECUTE ON FUNCTION public.payroll_get_run_type_policy(text, text)
  TO authenticated, service_role;

-- Seed canonical defaults. Idempotent — run-type unique among country=NULL rows.
INSERT INTO public.payroll_run_type_policies
  (country_code, run_type,
   applies_recurring_earnings, applies_recurring_deductions, applies_statutory,
   applies_loan_installments, applies_garnishments,
   accrues_leave, accrues_benefits,
   tax_method, population_source, requires_parent_run, notes)
VALUES
  (NULL,'regular',      true , true , true , true , true , true , true , 'ordinary'     ,'active_in_period'      ,false,'Standard cycle: everything applies.'),
  (NULL,'off_cycle',    false, false, true , false, false, false, false, 'ordinary'     ,'explicit'              ,false,'Late-hire / one-off payment. Statutory still applies on the paid amount; recurring streams suppressed.'),
  (NULL,'bonus',        false, false, true , false, false, false, false, 'annualized'   ,'explicit'              ,false,'Bonus paid outside the regular cycle. Annualized withholding by default; loans/garnishments do not auto-recover.'),
  (NULL,'commission',   false, false, true , false, false, false, false, 'ordinary'     ,'explicit'              ,false,'Commission payout. Statutory applies; recurring streams suppressed.'),
  (NULL,'13th_month',   false, false, true , false, false, false, false, 'separate_rate','active_in_period'      ,false,'13th-month / annual statutory bonus. Country pack may override tax_method.'),
  (NULL,'termination',  true , true , true , true , true , false, false, 'ordinary'     ,'terminating_in_period' ,false,'Final pay. Recurring + statutory + loan settlement + garnishments run; accruals stop.'),
  (NULL,'supplemental', false, false, true , false, false, false, false, 'ordinary'     ,'parent_run'            ,true ,'Adds missed items to a posted run. Inherits population from parent; recurring streams suppressed.'),
  (NULL,'correction',   false, false, true , false, false, false, false, 'ordinary'     ,'parent_run'            ,true ,'Signed delta against a posted run. Delta engine (Phase 3.4) computes against the parent baseline.')
ON CONFLICT DO NOTHING;
