
-- ─── Phase 3 — Persist per-rule provenance traces ───────────────────────
-- One row per rule evaluated by runStructureEngine per (run, employee).
-- Additive: legacy payslip_lines remain the authoritative amounts;
-- this table backs audit, historical-simulator diff, and rule-graph
-- debug UIs without re-running the engine.

CREATE TABLE IF NOT EXISTS public.payroll_rule_traces (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  business_id UUID NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
  payroll_run_id UUID NOT NULL REFERENCES public.payroll_runs(id) ON DELETE CASCADE,
  payslip_id UUID REFERENCES public.payslips(id) ON DELETE CASCADE,
  employee_id UUID NOT NULL REFERENCES public.employees(id) ON DELETE CASCADE,
  structure_id UUID REFERENCES public.salary_structures(id) ON DELETE SET NULL,
  rule_id UUID,
  rule_code TEXT NOT NULL,
  sequence INTEGER NOT NULL DEFAULT 0,
  category TEXT NOT NULL,
  condition_expression TEXT,
  condition_passed BOOLEAN NOT NULL,
  amount_select TEXT NOT NULL,
  amount_expression TEXT,
  amount_base TEXT,
  base_value NUMERIC(18,4) NOT NULL DEFAULT 0,
  dependencies TEXT[] NOT NULL DEFAULT '{}'::text[],
  resolved_amount NUMERIC(18,4) NOT NULL DEFAULT 0,
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_payroll_rule_traces_run ON public.payroll_rule_traces(payroll_run_id);
CREATE INDEX IF NOT EXISTS idx_payroll_rule_traces_payslip ON public.payroll_rule_traces(payslip_id);
CREATE INDEX IF NOT EXISTS idx_payroll_rule_traces_employee ON public.payroll_rule_traces(employee_id);
CREATE INDEX IF NOT EXISTS idx_payroll_rule_traces_org_biz ON public.payroll_rule_traces(organization_id, business_id);

GRANT SELECT ON public.payroll_rule_traces TO authenticated;
GRANT ALL ON public.payroll_rule_traces TO service_role;

ALTER TABLE public.payroll_rule_traces ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "payroll_rule_traces_select" ON public.payroll_rule_traces;
CREATE POLICY "payroll_rule_traces_select" ON public.payroll_rule_traces FOR SELECT TO authenticated
USING (
  business_id IS NOT NULL
  AND public.user_can_access_business(auth.uid(), business_id)
  AND public.user_has_module_permission(auth.uid(), organization_id, business_id, 'payroll', 'read')
);

-- Inserts are done by the compute-payroll edge function via service_role,
-- which bypasses RLS. No end-user insert path is desirable — the trace is
-- engine-produced provenance only. Deliberately no INSERT policy for
-- authenticated.

COMMENT ON TABLE public.payroll_rule_traces IS
  'Phase 3 — Per-rule provenance from runStructureEngine. Additive to payslip_lines; used by rule-graph debug + historical simulator. Written by compute-payroll only.';


-- ─── Phase 3 — Backfill RPC: salary_components → payroll_salary_rules ───

CREATE OR REPLACE FUNCTION public.migrate_components_to_rules(p_structure_id uuid)
RETURNS TABLE(rules_created integer, already_migrated boolean, flag_flipped boolean)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_org uuid;
  v_biz uuid;
  v_use_engine boolean;
  v_existing int;
  v_created int := 0;
  v_flag_flipped boolean := false;
  r RECORD;
  v_expr text;
  v_amount_select text;
  v_amount_fixed numeric;
  v_amount_pct numeric;
  v_amount_base text;
  v_category text;
BEGIN
  SELECT organization_id, business_id, COALESCE(use_structure_engine, false)
    INTO v_org, v_biz, v_use_engine
  FROM public.salary_structures WHERE id = p_structure_id;

  IF v_org IS NULL THEN
    RAISE EXCEPTION 'salary structure % not found', p_structure_id
      USING ERRCODE = 'no_data_found';
  END IF;

  -- Authorization: caller must have payroll write on this org.
  IF NOT public.user_has_module_permission(auth.uid(), v_org, 'payroll', 'write') THEN
    RAISE EXCEPTION 'not authorized to migrate salary structure %', p_structure_id
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  SELECT count(*) INTO v_existing FROM public.payroll_salary_rules WHERE structure_id = p_structure_id;
  IF v_existing > 0 THEN
    RETURN QUERY SELECT 0::int, true, false;
    RETURN;
  END IF;

  FOR r IN
    SELECT * FROM public.salary_components
    WHERE structure_id = p_structure_id AND COALESCE(is_active, true) = true
    ORDER BY COALESCE(sort_order, 0), name
  LOOP
    -- Category mapping from component_type
    v_category := CASE lower(COALESCE(r.component_type, 'earning'))
      WHEN 'earning' THEN
        CASE lower(COALESCE(r.code, ''))
          WHEN 'basic' THEN 'basic'
          WHEN 'basic_salary' THEN 'basic'
          ELSE 'allowance'
        END
      WHEN 'deduction' THEN 'deduction'
      WHEN 'employer_contribution' THEN 'employer_contribution'
      ELSE 'other'
    END;

    v_amount_select := 'fixed';
    v_amount_fixed := NULL;
    v_amount_pct := NULL;
    v_amount_base := NULL;
    v_expr := NULL;

    IF lower(COALESCE(r.computation_type, 'fixed')) = 'fixed' THEN
      v_amount_select := 'fixed';
      v_amount_fixed := COALESCE(r.computation_value, 0);
    ELSIF lower(r.computation_type) = 'percentage' THEN
      v_amount_select := 'percentage';
      v_amount_pct := COALESCE(r.computation_value, 0);
      v_amount_base := CASE upper(COALESCE(r.percentage_of, 'BASIC'))
        WHEN 'GROSS' THEN 'GROSS'
        WHEN 'TAXABLE' THEN 'TAXABLE'
        WHEN 'NET' THEN 'NET'
        ELSE 'BASIC'
      END;
    ELSIF lower(r.computation_type) = 'formula' THEN
      v_amount_select := 'expression';
      v_expr := COALESCE(NULLIF(trim(r.percentage_of), ''), '0');
      -- Legacy formula string historically lived in percentage_of;
      -- callers can edit after migration if the shape differs.
    END IF;

    INSERT INTO public.payroll_salary_rules (
      organization_id, business_id, structure_id,
      code, name, sequence, category,
      condition_select, condition_expression,
      amount_select, amount_fixed, amount_percentage, amount_base, amount_expression,
      appears_on_payslip, is_active
    ) VALUES (
      v_org, v_biz, p_structure_id,
      upper(COALESCE(NULLIF(r.code, ''), regexp_replace(r.name, '[^A-Za-z0-9]+', '_', 'g'))),
      r.name,
      COALESCE(r.sort_order, 0) * 10 + 100,
      v_category,
      'always', NULL,
      v_amount_select, v_amount_fixed, v_amount_pct, v_amount_base, v_expr,
      true, true
    );
    v_created := v_created + 1;
  END LOOP;

  IF v_created > 0 AND NOT v_use_engine THEN
    UPDATE public.salary_structures
       SET use_structure_engine = true, updated_at = now()
     WHERE id = p_structure_id;
    v_flag_flipped := true;
  END IF;

  RETURN QUERY SELECT v_created, false, v_flag_flipped;
END;
$$;

REVOKE ALL ON FUNCTION public.migrate_components_to_rules(uuid) FROM public;
GRANT EXECUTE ON FUNCTION public.migrate_components_to_rules(uuid) TO authenticated;

COMMENT ON FUNCTION public.migrate_components_to_rules(uuid) IS
  'Phase 3 — Idempotent backfill of salary_components into payroll_salary_rules for the given structure, then flips use_structure_engine=true if new rules were created. No-ops when the structure already has rules.';
