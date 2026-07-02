
ALTER TABLE public.salary_structures
  ADD COLUMN IF NOT EXISTS business_id uuid REFERENCES public.businesses(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS use_structure_engine boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS engine_version integer NOT NULL DEFAULT 1;

CREATE INDEX IF NOT EXISTS idx_salary_structures_business
  ON public.salary_structures(business_id) WHERE business_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.payroll_salary_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  business_id uuid REFERENCES public.businesses(id) ON DELETE SET NULL,
  structure_id uuid NOT NULL REFERENCES public.salary_structures(id) ON DELETE CASCADE,
  parent_rule_id uuid REFERENCES public.payroll_salary_rules(id) ON DELETE SET NULL,
  code text NOT NULL,
  name text NOT NULL,
  sequence integer NOT NULL DEFAULT 100,
  category text NOT NULL DEFAULT 'other'
    CHECK (category IN ('basic','allowance','deduction','employer_contribution','net','gross','other')),
  condition_select text NOT NULL DEFAULT 'always'
    CHECK (condition_select IN ('always','expression')),
  condition_expression text,
  amount_select text NOT NULL DEFAULT 'fixed'
    CHECK (amount_select IN ('fixed','percentage','expression','statutory_ref')),
  amount_fixed numeric(18,4),
  amount_percentage numeric(9,4),
  amount_base text,
  amount_expression text,
  statutory_rule_id uuid REFERENCES public.payroll_statutory_rules(id) ON DELETE SET NULL,
  appears_on_payslip boolean NOT NULL DEFAULT true,
  accounting_debit_account_id uuid REFERENCES public.accounts(id) ON DELETE SET NULL,
  accounting_credit_account_id uuid REFERENCES public.accounts(id) ON DELETE SET NULL,
  accounting_tag text,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  updated_by uuid,
  UNIQUE (structure_id, code)
);

CREATE INDEX IF NOT EXISTS idx_payroll_salary_rules_structure
  ON public.payroll_salary_rules(structure_id, sequence);
CREATE INDEX IF NOT EXISTS idx_payroll_salary_rules_org
  ON public.payroll_salary_rules(organization_id);
CREATE INDEX IF NOT EXISTS idx_payroll_salary_rules_parent
  ON public.payroll_salary_rules(parent_rule_id) WHERE parent_rule_id IS NOT NULL;

ALTER TABLE public.payroll_salary_rules ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "payroll_salary_rules_read" ON public.payroll_salary_rules;
CREATE POLICY "payroll_salary_rules_read" ON public.payroll_salary_rules
  FOR SELECT TO authenticated
  USING (public.user_has_module_permission(auth.uid(), organization_id, 'hr', 'read'));
DROP POLICY IF EXISTS "payroll_salary_rules_write" ON public.payroll_salary_rules;
CREATE POLICY "payroll_salary_rules_write" ON public.payroll_salary_rules
  FOR ALL TO authenticated
  USING (public.user_has_module_permission(auth.uid(), organization_id, 'payroll', 'write'))
  WITH CHECK (public.user_has_module_permission(auth.uid(), organization_id, 'payroll', 'write'));

CREATE TABLE IF NOT EXISTS public.payroll_work_entry_types (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  business_id uuid REFERENCES public.businesses(id) ON DELETE CASCADE,
  localization_pack_id uuid,
  code text NOT NULL,
  name text NOT NULL,
  color text,
  is_paid boolean NOT NULL DEFAULT true,
  is_unpaid_leave boolean NOT NULL DEFAULT false,
  counts_as_worked boolean NOT NULL DEFAULT true,
  multiplier_normal numeric(8,4) NOT NULL DEFAULT 1,
  multiplier_overtime numeric(8,4) NOT NULL DEFAULT 1.5,
  accounting_tag text,
  sequence integer NOT NULL DEFAULT 100,
  is_active boolean NOT NULL DEFAULT true,
  is_pack_default boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  updated_by uuid
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_work_entry_types_business_code
  ON public.payroll_work_entry_types(organization_id, COALESCE(business_id, '00000000-0000-0000-0000-000000000000'::uuid), code);
CREATE INDEX IF NOT EXISTS idx_work_entry_types_org
  ON public.payroll_work_entry_types(organization_id);

ALTER TABLE public.payroll_work_entry_types ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "payroll_work_entry_types_read" ON public.payroll_work_entry_types;
CREATE POLICY "payroll_work_entry_types_read" ON public.payroll_work_entry_types
  FOR SELECT TO authenticated
  USING (public.user_has_module_permission(auth.uid(), organization_id, 'hr', 'read'));
DROP POLICY IF EXISTS "payroll_work_entry_types_write" ON public.payroll_work_entry_types;
CREATE POLICY "payroll_work_entry_types_write" ON public.payroll_work_entry_types
  FOR ALL TO authenticated
  USING (
    public.user_has_module_permission(auth.uid(), organization_id, 'payroll', 'write')
    AND business_id IS NOT NULL
  )
  WITH CHECK (
    public.user_has_module_permission(auth.uid(), organization_id, 'payroll', 'write')
    AND business_id IS NOT NULL
  );

ALTER TABLE public.payroll_work_entries
  ADD COLUMN IF NOT EXISTS work_entry_type_id uuid
    REFERENCES public.payroll_work_entry_types(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_pwe_type
  ON public.payroll_work_entries(work_entry_type_id) WHERE work_entry_type_id IS NOT NULL;

DROP TRIGGER IF EXISTS trg_payroll_salary_rules_updated_at ON public.payroll_salary_rules;
CREATE TRIGGER trg_payroll_salary_rules_updated_at
  BEFORE UPDATE ON public.payroll_salary_rules
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

DROP TRIGGER IF EXISTS trg_payroll_work_entry_types_updated_at ON public.payroll_work_entry_types;
CREATE TRIGGER trg_payroll_work_entry_types_updated_at
  BEFORE UPDATE ON public.payroll_work_entry_types
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE OR REPLACE FUNCTION public.audit_payroll_structure_changes()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_org uuid;
BEGIN
  v_org := COALESCE(NEW.organization_id, OLD.organization_id);
  INSERT INTO public.audit_logs (
    organization_id, user_id, table_name, record_id, action, changes_summary, metadata
  ) VALUES (
    v_org,
    auth.uid(),
    TG_TABLE_NAME,
    COALESCE(NEW.id, OLD.id),
    lower(TG_OP),
    CASE
      WHEN TG_OP = 'INSERT' THEN format('Created %s', TG_TABLE_NAME)
      WHEN TG_OP = 'UPDATE' THEN format('Updated %s', TG_TABLE_NAME)
      WHEN TG_OP = 'DELETE' THEN format('Deleted %s', TG_TABLE_NAME)
    END,
    jsonb_build_object(
      'old', CASE WHEN TG_OP <> 'INSERT' THEN to_jsonb(OLD) ELSE NULL END,
      'new', CASE WHEN TG_OP <> 'DELETE' THEN to_jsonb(NEW) ELSE NULL END
    )
  );
  RETURN COALESCE(NEW, OLD);
END;
$$;

DROP TRIGGER IF EXISTS trg_audit_payroll_salary_rules ON public.payroll_salary_rules;
CREATE TRIGGER trg_audit_payroll_salary_rules
  AFTER INSERT OR UPDATE OR DELETE ON public.payroll_salary_rules
  FOR EACH ROW EXECUTE FUNCTION public.audit_payroll_structure_changes();

DROP TRIGGER IF EXISTS trg_audit_payroll_work_entry_types ON public.payroll_work_entry_types;
CREATE TRIGGER trg_audit_payroll_work_entry_types
  AFTER INSERT OR UPDATE OR DELETE ON public.payroll_work_entry_types
  FOR EACH ROW EXECUTE FUNCTION public.audit_payroll_structure_changes();
