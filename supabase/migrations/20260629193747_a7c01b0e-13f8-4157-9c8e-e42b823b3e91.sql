-- Reverse the short-lived P1.2e v1 flag — it never published to packs.
DROP INDEX IF EXISTS public.idx_payroll_salary_rules_variable_input;
ALTER TABLE public.payroll_salary_rules
  DROP COLUMN IF EXISTS is_variable_input;

-- Adopt the Odoo / SAP / Workday two-table pattern: a first-class
-- registry of payroll input types, separate from the rule graph.
CREATE TYPE public.payroll_input_unit AS ENUM ('amount', 'hours', 'days', 'count');

CREATE TABLE public.payroll_input_types (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  business_id uuid NULL,
  code text NOT NULL,
  name text NOT NULL,
  description text NULL,
  input_unit public.payroll_input_unit NOT NULL DEFAULT 'amount',
  default_value numeric NULL,
  min_value numeric NULL,
  max_value numeric NULL,
  is_required boolean NOT NULL DEFAULT false,
  -- Optional applicability. Empty array = applies to all structures
  -- in the org/business scope. Mirrors Odoo `hr.payslip.input.type.struct_ids`.
  structure_ids uuid[] NOT NULL DEFAULT '{}',
  is_active boolean NOT NULL DEFAULT true,
  sequence integer NOT NULL DEFAULT 100,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid NULL,
  updated_by uuid NULL
);

COMMENT ON TABLE public.payroll_input_types IS
  'Phase 4 P1.2e — registry of pack-declared variable payroll inputs. One row per per-run input slot (overtime hours, bonus amount, commission, …). The payroll-create UI renders one column per row that applies in scope. Mirrors Odoo hr.payslip.input.type / SAP wage-type permissibility / Workday pay-component input templates. Per-employee values live in public.payslip_inputs.';

COMMENT ON COLUMN public.payroll_input_types.code IS
  'The rule code this input feeds. The engine looks up `varEarnings[code]` when evaluating the matching `payroll_salary_rules` row. Same code may legitimately feed several rules (earning + statutory + tax adjustment) — that is why this lives in a separate registry rather than as a flag on the rule.';

COMMENT ON COLUMN public.payroll_input_types.structure_ids IS
  'Salary structures this input applies to. Empty array means all structures in the (org, business) scope. Mirrors Odoo `struct_ids`.';

-- Uniqueness per scope: same (org, business) cannot declare the same
-- input code twice. NULL business_id is treated as a distinct slot
-- (org-wide default) via the partial unique indexes below.
CREATE UNIQUE INDEX payroll_input_types_unique_org_scope
  ON public.payroll_input_types (organization_id, code)
  WHERE business_id IS NULL;

CREATE UNIQUE INDEX payroll_input_types_unique_business_scope
  ON public.payroll_input_types (organization_id, business_id, code)
  WHERE business_id IS NOT NULL;

CREATE INDEX payroll_input_types_lookup
  ON public.payroll_input_types (organization_id, business_id, is_active);

-- Standard updated_at trigger.
CREATE OR REPLACE FUNCTION public.touch_payroll_input_types_updated_at()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_payroll_input_types_updated_at
  BEFORE UPDATE ON public.payroll_input_types
  FOR EACH ROW EXECUTE FUNCTION public.touch_payroll_input_types_updated_at();

-- GRANTs (PostgREST does not grant default privileges on public).
-- Auth-only: pack/admin UIs author; payroll UI reads. No anon path.
GRANT SELECT, INSERT, UPDATE, DELETE ON public.payroll_input_types TO authenticated;
GRANT ALL ON public.payroll_input_types TO service_role;

ALTER TABLE public.payroll_input_types ENABLE ROW LEVEL SECURITY;

-- Read: any org member with HR read permission (mirrors
-- payroll_salary_rules_read).
CREATE POLICY payroll_input_types_read
  ON public.payroll_input_types
  FOR SELECT
  TO authenticated
  USING (
    public.user_has_module_permission(auth.uid(), organization_id, 'hr', 'read')
  );

-- Write: payroll-write permission (mirrors payroll_salary_rules_write).
CREATE POLICY payroll_input_types_write
  ON public.payroll_input_types
  FOR ALL
  TO authenticated
  USING (
    public.user_has_module_permission(auth.uid(), organization_id, 'payroll', 'write')
  )
  WITH CHECK (
    public.user_has_module_permission(auth.uid(), organization_id, 'payroll', 'write')
  );