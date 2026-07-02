
-- P0-1: Create payroll_statutory_rules table for data-driven payroll calculations
CREATE TABLE IF NOT EXISTS public.payroll_statutory_rules (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  country_code text NOT NULL DEFAULT 'KE',
  rule_type text NOT NULL,
  rule_name text NOT NULL,
  parameters jsonb NOT NULL DEFAULT '{}'::jsonb,
  effective_from date NOT NULL DEFAULT '2024-01-01',
  effective_to date,
  sort_order integer NOT NULL DEFAULT 0,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.payroll_statutory_rules ENABLE ROW LEVEL SECURITY;

CREATE POLICY "payroll_statutory_rules_select"
ON public.payroll_statutory_rules FOR SELECT
USING (organization_id IN (
  SELECT organization_id FROM public.user_roles WHERE user_id = auth.uid()
));

CREATE POLICY "payroll_statutory_rules_all"
ON public.payroll_statutory_rules FOR ALL
USING (organization_id IN (
  SELECT organization_id FROM public.user_roles WHERE user_id = auth.uid()
));

CREATE INDEX IF NOT EXISTS idx_payroll_statutory_rules_lookup
ON public.payroll_statutory_rules (organization_id, country_code, rule_type, sort_order)
WHERE is_active = true;
