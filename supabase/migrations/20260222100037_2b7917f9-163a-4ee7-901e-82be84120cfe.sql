
-- Create a table for dynamic payroll rule types
CREATE TABLE public.payroll_rule_types (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  code text NOT NULL,
  label text NOT NULL,
  description text,
  parameter_schema jsonb NOT NULL DEFAULT '[]'::jsonb,
  is_bracket boolean NOT NULL DEFAULT false,
  is_system boolean NOT NULL DEFAULT false,
  is_active boolean NOT NULL DEFAULT true,
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(organization_id, code)
);

-- parameter_schema is a JSON array of field definitions:
-- [{"key": "lower", "label": "Lower Limit", "type": "number", "placeholder": "e.g. 0", "optional": false}, ...]

COMMENT ON TABLE public.payroll_rule_types IS 'Dynamic rule type definitions for payroll statutory rules. Replaces hardcoded rule types.';
COMMENT ON COLUMN public.payroll_rule_types.code IS 'Machine-readable code used in payroll_statutory_rules.rule_type';
COMMENT ON COLUMN public.payroll_rule_types.parameter_schema IS 'JSON array defining the parameter fields for this rule type';
COMMENT ON COLUMN public.payroll_rule_types.is_bracket IS 'Whether this rule type uses multiple sorted brackets';
COMMENT ON COLUMN public.payroll_rule_types.is_system IS 'System-defined types cannot be deleted but can be edited';

CREATE INDEX idx_payroll_rule_types_org ON public.payroll_rule_types(organization_id);

ALTER TABLE public.payroll_rule_types ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view rule types for their organization"
  ON public.payroll_rule_types FOR SELECT
  USING (organization_id IN (
    SELECT organization_id FROM public.user_roles WHERE user_id = auth.uid()
  ));

CREATE POLICY "Users with manage permission can insert rule types"
  ON public.payroll_rule_types FOR INSERT
  WITH CHECK (organization_id IN (
    SELECT organization_id FROM public.user_roles WHERE user_id = auth.uid()
  ));

CREATE POLICY "Users with manage permission can update rule types"
  ON public.payroll_rule_types FOR UPDATE
  USING (organization_id IN (
    SELECT organization_id FROM public.user_roles WHERE user_id = auth.uid()
  ));

CREATE POLICY "Users with manage permission can delete non-system rule types"
  ON public.payroll_rule_types FOR DELETE
  USING (
    is_system = false AND
    organization_id IN (
      SELECT organization_id FROM public.user_roles WHERE user_id = auth.uid()
    )
  );

CREATE TRIGGER update_payroll_rule_types_updated_at
  BEFORE UPDATE ON public.payroll_rule_types
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- Seed default rule types for all organizations
INSERT INTO public.payroll_rule_types (organization_id, code, label, description, parameter_schema, is_bracket, is_system, sort_order)
SELECT o.id, v.code, v.label, v.description, v.parameter_schema::jsonb, v.is_bracket, true, v.sort_order
FROM organizations o
CROSS JOIN (VALUES
  ('paye_bracket', 'PAYE Tax Bracket', 'Income tax bracket with lower/upper limits and rate',
   '[{"key":"lower","label":"Lower Limit","type":"number","placeholder":"e.g. 0"},{"key":"upper","label":"Upper Limit (blank = no limit)","type":"number","placeholder":"e.g. 24000","optional":true},{"key":"rate","label":"Tax Rate (decimal)","type":"number","placeholder":"e.g. 0.10 for 10%","step":"0.001"}]',
   true, 1),
  ('nhif_bracket', 'NHIF/SHIF Bracket', 'Health insurance contribution bracket',
   '[{"key":"lower","label":"Lower Limit (Gross)","type":"number","placeholder":"e.g. 0"},{"key":"upper","label":"Upper Limit (Gross)","type":"number","placeholder":"e.g. 5999"},{"key":"amount","label":"Contribution Amount","type":"number","placeholder":"e.g. 150"}]',
   true, 2),
  ('nssf', 'NSSF Contribution', 'Social security fund tier limits and rate',
   '[{"key":"tier1_limit","label":"Tier I Limit","type":"number","placeholder":"e.g. 7000"},{"key":"tier2_limit","label":"Tier II Limit","type":"number","placeholder":"e.g. 36000"},{"key":"rate","label":"Contribution Rate (decimal)","type":"number","placeholder":"e.g. 0.06","step":"0.001"}]',
   false, 3),
  ('housing_levy', 'Housing Levy', 'Housing levy percentage rate',
   '[{"key":"rate","label":"Levy Rate (decimal)","type":"number","placeholder":"e.g. 0.015 for 1.5%","step":"0.001"}]',
   false, 4),
  ('personal_relief', 'Personal Relief', 'Monthly personal tax relief amount',
   '[{"key":"amount","label":"Monthly Relief Amount","type":"number","placeholder":"e.g. 2400"}]',
   false, 5),
  ('housing_exemption', 'Housing Exemption', 'Max exempt housing benefit amount',
   '[{"key":"max_amount","label":"Max Exempt Amount","type":"number","placeholder":"e.g. 15000"}]',
   false, 6)
) AS v(code, label, description, parameter_schema, is_bracket, sort_order)
WHERE NOT EXISTS (
  SELECT 1 FROM public.payroll_rule_types prt WHERE prt.organization_id = o.id AND prt.code = v.code
);
