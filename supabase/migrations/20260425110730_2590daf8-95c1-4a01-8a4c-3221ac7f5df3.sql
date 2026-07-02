
CREATE OR REPLACE FUNCTION public.validate_payroll_run_mappings(p_run_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_run            payroll_runs%ROWTYPE;
  v_required_keys  text[] := ARRAY['salary_expense', 'net_salary_payable'];
  v_used_keys      text[] := ARRAY[]::text[];
  v_existing_keys  text[];
  v_missing_keys   text[];
  v_dd             jsonb;
  v_cd             jsonb;
  v_key            text;
BEGIN
  SELECT * INTO v_run FROM payroll_runs WHERE id = p_run_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object(
      'ok', false,
      'missing_keys', ARRAY[]::text[],
      'summary', 'Payroll run not found'
    );
  END IF;

  -- Membership check — only members of the run's org can preflight it
  IF NOT public.is_org_member(v_run.organization_id) THEN
    RAISE EXCEPTION 'Not authorized to validate this payroll run';
  END IF;

  -- Walk every payslip in the run, collect deduction/contribution keys
  FOR v_dd, v_cd IN
    SELECT
      COALESCE(deductions_detail::jsonb, '{}'::jsonb),
      COALESCE(contributions_detail::jsonb, '{}'::jsonb)
    FROM payslips
    WHERE payroll_run_id = p_run_id
  LOOP
    -- Deductions: need either {key}_payable OR {key}
    FOR v_key IN SELECT jsonb_object_keys(v_dd) LOOP
      IF (v_dd ->> v_key)::numeric > 0 THEN
        v_used_keys := v_used_keys || (v_key || '_payable');
      END IF;
    END LOOP;
    -- Contributions: need {key}_expense and {key}_payable
    FOR v_key IN SELECT jsonb_object_keys(v_cd) LOOP
      IF (v_cd ->> v_key)::numeric > 0 THEN
        v_used_keys := v_used_keys || (v_key || '_expense');
        v_used_keys := v_used_keys || (v_key || '_payable');
      END IF;
    END LOOP;
  END LOOP;

  -- Required core keys + the deduction/contribution keys (deduplicated)
  v_required_keys := (
    SELECT ARRAY(SELECT DISTINCT unnest(v_required_keys || v_used_keys))
  );

  -- Existing mappings for this org/business (business overrides org)
  SELECT ARRAY(
    SELECT DISTINCT mapping_key
    FROM payroll_account_mappings
    WHERE organization_id = v_run.organization_id
      AND (business_id IS NULL OR business_id = v_run.business_id)
      AND is_active = true
      AND account_id IS NOT NULL
  ) INTO v_existing_keys;

  -- For deduction keys we accept either {key}_payable or the bare {key}
  v_missing_keys := ARRAY(
    SELECT k
    FROM unnest(v_required_keys) AS k
    WHERE k <> ALL(COALESCE(v_existing_keys, ARRAY[]::text[]))
      AND CASE
            WHEN k LIKE '%_payable' THEN
              regexp_replace(k, '_payable$', '') <> ALL(COALESCE(v_existing_keys, ARRAY[]::text[]))
            ELSE true
          END
  );

  RETURN jsonb_build_object(
    'ok', cardinality(v_missing_keys) = 0,
    'missing_keys', v_missing_keys,
    'required_keys', v_required_keys,
    'existing_keys', COALESCE(v_existing_keys, ARRAY[]::text[]),
    'summary', CASE
      WHEN cardinality(v_missing_keys) = 0
        THEN 'All required account mappings are configured.'
      ELSE format('%s mapping(s) missing — configure them in Payroll Settings → Account Mappings.', cardinality(v_missing_keys))
    END
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.validate_payroll_run_mappings(uuid) TO authenticated;

COMMENT ON FUNCTION public.validate_payroll_run_mappings(uuid) IS
  'Wave 3: Pre-flight validator for payroll → GL posting. Returns the exact list of missing mapping keys so the UI can block "Post to GL" before failing mid-flight.';
