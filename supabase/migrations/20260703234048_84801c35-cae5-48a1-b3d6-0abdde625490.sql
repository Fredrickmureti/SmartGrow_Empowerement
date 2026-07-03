
DROP FUNCTION IF EXISTS public._ss_authorize(uuid, text) CASCADE;

CREATE FUNCTION public._ss_authorize(p_id uuid, p_permission text)
RETURNS TABLE(
  out_org_id uuid,
  out_biz_id uuid,
  out_structure_name text,
  out_is_active boolean,
  out_archived_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_org uuid; v_biz uuid; v_name text; v_active boolean; v_arch timestamptz;
BEGIN
  SELECT organization_id, business_id, name, COALESCE(is_active, true), archived_at
    INTO v_org, v_biz, v_name, v_active, v_arch
  FROM public.salary_structures WHERE id = p_id;
  IF v_org IS NULL THEN
    RAISE EXCEPTION 'salary structure % not found', p_id USING ERRCODE = 'no_data_found';
  END IF;
  IF NOT public.user_has_module_permission(auth.uid(), v_org, v_biz, 'hr', p_permission) THEN
    RAISE EXCEPTION 'not authorized: hr.% required for salary structure %', p_permission, p_id
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN QUERY SELECT v_org, v_biz, v_name, v_active, v_arch;
END;
$$;

REVOKE ALL ON FUNCTION public._ss_authorize(uuid, text) FROM public;

CREATE OR REPLACE FUNCTION public.rename_salary_structure(
  p_id uuid,
  p_name text,
  p_code text DEFAULT NULL,
  p_description text DEFAULT NULL
) RETURNS public.salary_structures
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  a RECORD;
  v_row public.salary_structures;
  v_old_name text;
  v_old_code text;
BEGIN
  SELECT * INTO a FROM public._ss_authorize(p_id, 'write');

  IF p_name IS NULL OR btrim(p_name) = '' THEN
    RAISE EXCEPTION 'name is required' USING ERRCODE = 'invalid_parameter_value';
  END IF;

  SELECT name, code INTO v_old_name, v_old_code FROM public.salary_structures WHERE id = p_id;

  UPDATE public.salary_structures
     SET name = btrim(p_name),
         code = NULLIF(btrim(COALESCE(p_code, code)), ''),
         description = COALESCE(p_description, description),
         updated_at = now()
   WHERE id = p_id
  RETURNING * INTO v_row;

  INSERT INTO public.salary_structure_lifecycle_events
    (organization_id, business_id, structure_id, structure_name_snapshot, event, actor, payload)
  VALUES
    (a.out_org_id, a.out_biz_id, p_id, v_row.name, 'renamed', auth.uid(),
     jsonb_build_object('old_name', v_old_name, 'new_name', v_row.name,
                        'old_code', v_old_code, 'new_code', v_row.code));

  RETURN v_row;
END;
$$;

REVOKE ALL ON FUNCTION public.rename_salary_structure(uuid, text, text, text) FROM public;
GRANT EXECUTE ON FUNCTION public.rename_salary_structure(uuid, text, text, text) TO authenticated;

CREATE OR REPLACE FUNCTION public.archive_salary_structure(
  p_id uuid,
  p_reason text DEFAULT NULL
) RETURNS public.salary_structures
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  a RECORD;
  v_row public.salary_structures;
BEGIN
  SELECT * INTO a FROM public._ss_authorize(p_id, 'write');

  UPDATE public.salary_structures
     SET is_active = false, archived_at = now(), updated_at = now()
   WHERE id = p_id
  RETURNING * INTO v_row;

  INSERT INTO public.salary_structure_lifecycle_events
    (organization_id, business_id, structure_id, structure_name_snapshot,
     event, from_state, to_state, reason, actor)
  VALUES
    (a.out_org_id, a.out_biz_id, p_id, v_row.name,
     'archived',
     CASE WHEN a.out_is_active THEN 'active' ELSE 'archived' END,
     'archived', p_reason, auth.uid());

  RETURN v_row;
END;
$$;

REVOKE ALL ON FUNCTION public.archive_salary_structure(uuid, text) FROM public;
GRANT EXECUTE ON FUNCTION public.archive_salary_structure(uuid, text) TO authenticated;

CREATE OR REPLACE FUNCTION public.restore_salary_structure(p_id uuid)
RETURNS public.salary_structures
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  a RECORD;
  v_row public.salary_structures;
BEGIN
  SELECT * INTO a FROM public._ss_authorize(p_id, 'write');

  UPDATE public.salary_structures
     SET is_active = true, archived_at = NULL, updated_at = now()
   WHERE id = p_id
  RETURNING * INTO v_row;

  INSERT INTO public.salary_structure_lifecycle_events
    (organization_id, business_id, structure_id, structure_name_snapshot,
     event, from_state, to_state, actor)
  VALUES
    (a.out_org_id, a.out_biz_id, p_id, v_row.name, 'restored', 'archived', 'active', auth.uid());

  RETURN v_row;
END;
$$;

REVOKE ALL ON FUNCTION public.restore_salary_structure(uuid) FROM public;
GRANT EXECUTE ON FUNCTION public.restore_salary_structure(uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.salary_structure_deletion_report(p_id uuid)
RETURNS TABLE(
  structure_id uuid,
  is_archived boolean,
  contract_count integer,
  payslip_count integer,
  active_run_count integer,
  can_delete boolean
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  a RECORD;
  v_contracts int;
  v_payslips int;
  v_runs int;
BEGIN
  SELECT * INTO a FROM public._ss_authorize(p_id, 'read');

  SELECT count(*) INTO v_contracts
    FROM public.employee_contracts WHERE salary_structure_id = p_id;

  SELECT count(*) INTO v_payslips
    FROM public.payslips ps
    JOIN public.salary_structure_rule_sets rs ON rs.id = ps.rule_set_id
   WHERE rs.structure_id = p_id;

  SELECT count(DISTINCT pr.id) INTO v_runs
    FROM public.payroll_runs pr
    JOIN public.payslips ps ON ps.payroll_run_id = pr.id
    JOIN public.salary_structure_rule_sets rs ON rs.id = ps.rule_set_id
   WHERE rs.structure_id = p_id
     AND COALESCE(pr.status, '') NOT IN ('completed','paid','closed','cancelled','failed');

  RETURN QUERY SELECT
    p_id,
    (a.out_archived_at IS NOT NULL),
    v_contracts,
    v_payslips,
    v_runs,
    (a.out_archived_at IS NOT NULL AND v_contracts = 0 AND v_payslips = 0 AND v_runs = 0);
END;
$$;

REVOKE ALL ON FUNCTION public.salary_structure_deletion_report(uuid) FROM public;
GRANT EXECUTE ON FUNCTION public.salary_structure_deletion_report(uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.delete_salary_structure(
  p_id uuid,
  p_confirm_name text
) RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  a RECORD;
  r RECORD;
  v_name text;
BEGIN
  SELECT * INTO a FROM public._ss_authorize(p_id, 'delete');

  SELECT name INTO v_name FROM public.salary_structures WHERE id = p_id;

  IF btrim(COALESCE(p_confirm_name, '')) <> v_name THEN
    RAISE EXCEPTION 'confirmation name does not match structure name'
      USING ERRCODE = 'invalid_parameter_value',
            HINT = 'Type the exact structure name to confirm deletion.';
  END IF;

  SELECT * INTO r FROM public.salary_structure_deletion_report(p_id);

  IF NOT r.can_delete THEN
    RAISE EXCEPTION
      'cannot delete salary structure: archived=%, contracts=%, payslips=%, in-flight runs=%',
      r.is_archived, r.contract_count, r.payslip_count, r.active_run_count
      USING ERRCODE = 'foreign_key_violation',
            HINT = 'Archive the structure and clear all references first.';
  END IF;

  INSERT INTO public.salary_structure_lifecycle_events
    (organization_id, business_id, structure_id, structure_name_snapshot,
     event, from_state, to_state, actor)
  VALUES
    (a.out_org_id, a.out_biz_id, p_id, v_name, 'deleted', 'archived', 'deleted', auth.uid());

  DELETE FROM public.salary_structures WHERE id = p_id;
  RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION public.delete_salary_structure(uuid, text) FROM public;
GRANT EXECUTE ON FUNCTION public.delete_salary_structure(uuid, text) TO authenticated;
