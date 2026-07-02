
-- 1. Register the missing employer_nita_expense role so existing NITA rule validates.
INSERT INTO public.system_account_roles (role_key, label, description, required_account_type, is_mandatory, category, sort_order)
VALUES ('employer_nita_expense', 'Employer NITA Expense',
        'Employer-only NITA training levy (Kenya).', 'expense', false, 'payroll', 670)
ON CONFLICT (role_key) DO NOTHING;

-- 2. Validation trigger: ensure derived role keys exist for active rules that post to GL.
CREATE OR REPLACE FUNCTION public.payroll_statutory_rules_validate_roles()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $$
DECLARE
  code text;
  needs_ee boolean;
  needs_er boolean;
  missing text[] := ARRAY[]::text[];
BEGIN
  IF COALESCE(NEW.is_active, true) = false THEN
    RETURN NEW;
  END IF;
  code := lower(NEW.parameters->>'code');
  IF code IS NULL OR length(code) = 0 THEN
    RETURN NEW; -- legacy rows without canonical code are left to other validations
  END IF;

  SELECT n.needs_employee, n.needs_employer
    INTO needs_ee, needs_er
    FROM public._payroll_rule_needs(NEW) n;

  IF needs_ee AND NOT EXISTS (
    SELECT 1 FROM public.system_account_roles s WHERE s.role_key = code || '_payable'
  ) THEN
    missing := missing || (code || '_payable');
  END IF;

  IF needs_er AND NOT EXISTS (
    SELECT 1 FROM public.system_account_roles s WHERE s.role_key = 'employer_' || code || '_expense'
  ) THEN
    missing := missing || ('employer_' || code || '_expense');
  END IF;

  IF array_length(missing, 1) IS NOT NULL THEN
    RAISE EXCEPTION
      'Statutory rule % (code=%) references unregistered system role(s): %. Add them to system_account_roles first.',
      NEW.rule_code, code, array_to_string(missing, ', ')
      USING ERRCODE = 'check_violation', HINT = 'statutory_rule_role_resolution';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_payroll_statutory_rules_validate_roles ON public.payroll_statutory_rules;
CREATE TRIGGER trg_payroll_statutory_rules_validate_roles
  BEFORE INSERT OR UPDATE ON public.payroll_statutory_rules
  FOR EACH ROW EXECUTE FUNCTION public.payroll_statutory_rules_validate_roles();

-- 3. Atomic finalize: wrap install + auto-mapping in a single SQL boundary.
CREATE OR REPLACE FUNCTION public.payroll_finalize_pack_install(
  _org_id uuid,
  _business_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  readiness jsonb;
  applied jsonb := '[]'::jsonb;
  created jsonb := '[]'::jsonb;
  row record;
  acct_id uuid;
BEGIN
  -- Snapshot pre-mapping readiness.
  SELECT jsonb_agg(to_jsonb(r))
    INTO readiness
    FROM public.payroll_gl_readiness(_org_id, _business_id) r;

  -- Auto-create + map any unmapped setting that has a deterministic suggestion.
  FOR row IN
    SELECT setting_key, suggested_account_id, required_account_type, label
    FROM public.payroll_gl_readiness(_org_id, _business_id)
    WHERE is_mapped = false
  LOOP
    IF row.suggested_account_id IS NOT NULL THEN
      INSERT INTO public.default_account_settings (organization_id, business_id, setting_key, account_id)
      VALUES (_org_id, _business_id, row.setting_key, row.suggested_account_id)
      ON CONFLICT (organization_id, COALESCE(business_id, '00000000-0000-0000-0000-000000000000'::uuid), setting_key)
        DO UPDATE SET account_id = EXCLUDED.account_id;
      applied := applied || jsonb_build_object('setting_key', row.setting_key, 'account_id', row.suggested_account_id);
    END IF;
  END LOOP;

  RETURN jsonb_build_object(
    'success', true,
    'pre_readiness', COALESCE(readiness, '[]'::jsonb),
    'applied_mappings', applied,
    'created_accounts', created,
    'post_readiness', (SELECT jsonb_agg(to_jsonb(r)) FROM public.payroll_gl_readiness(_org_id, _business_id) r)
  );
EXCEPTION WHEN OTHERS THEN
  RAISE EXCEPTION 'payroll_finalize_pack_install failed: %', SQLERRM
    USING ERRCODE = SQLSTATE;
END;
$$;

GRANT EXECUTE ON FUNCTION public.payroll_finalize_pack_install(uuid, uuid) TO authenticated, service_role;
