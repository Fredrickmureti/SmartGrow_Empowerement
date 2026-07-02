
ALTER TABLE public.permission_group_rules
  ADD COLUMN IF NOT EXISTS can_admin_override boolean NOT NULL DEFAULT false;

CREATE OR REPLACE FUNCTION public.user_has_payroll_admin_override(_user_id uuid, _org_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    EXISTS (
      SELECT 1
      FROM public.user_roles ur
      WHERE ur.user_id = _user_id
        AND ur.organization_id = _org_id
        AND ur.is_active = true
        AND ur.role IN ('owner','super_admin','admin')
    )
    OR EXISTS (
      SELECT 1
      FROM public.member_permission_groups mpg
      JOIN public.permission_group_rules pgr
        ON pgr.permission_group_id = mpg.permission_group_id
      WHERE mpg.user_id = _user_id
        AND mpg.organization_id = _org_id
        AND pgr.module = 'payroll'
        AND pgr.can_admin_override = true
    );
$$;

CREATE OR REPLACE FUNCTION public.approve_payroll_run(p_run_id uuid)
 RETURNS payroll_runs
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_run public.payroll_runs;
  v_allowed boolean;
  v_override boolean;
  v_validation jsonb;
  v_missing text[];
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_run FROM public.payroll_runs WHERE id = p_run_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Payroll run not found' USING ERRCODE = 'P0002';
  END IF;

  IF v_run.status NOT IN ('draft','processed') THEN
    RAISE EXCEPTION 'Payroll run is in status % and cannot be approved.', v_run.status;
  END IF;

  v_allowed := public.user_has_module_permission(
    v_uid, v_run.organization_id, 'payroll', 'approve'
  );
  IF NOT v_allowed THEN
    RAISE EXCEPTION 'You do not have permission to approve payroll. Ask an admin to grant your Access Group the Payroll Approve permission.'
      USING ERRCODE = '42501';
  END IF;

  -- Maker-checker / Segregation of Duties: creator cannot self-approve unless
  -- they hold the payroll admin override (or are owner/super_admin/admin).
  IF v_run.created_by IS NOT NULL AND v_run.created_by = v_uid THEN
    v_override := public.user_has_payroll_admin_override(v_uid, v_run.organization_id);
    IF NOT v_override THEN
      RAISE EXCEPTION
        'Segregation of duties: the user who created this payroll run cannot also approve it. A different approver must review and approve.'
        USING ERRCODE = '42501',
              HINT    = 'payroll_maker_checker_violation';
    END IF;
  END IF;

  v_validation := public.validate_payroll_run_mappings(p_run_id);
  IF NOT COALESCE((v_validation->>'ok')::boolean, false) THEN
    v_missing := COALESCE(
      ARRAY(SELECT jsonb_array_elements_text(v_validation->'missing_keys')),
      ARRAY[]::text[]
    );
    RAISE EXCEPTION
      'Cannot approve: % GL account mapping(s) missing for this run — %. Configure them in Payroll → Configuration → GL Account Mapping.',
      cardinality(v_missing),
      array_to_string(v_missing, ', ')
      USING ERRCODE = 'P0001',
            HINT    = 'payroll_missing_mappings';
  END IF;

  UPDATE public.payroll_runs
     SET status = 'approved',
         approved_by = v_uid,
         approved_at = now(),
         updated_at = now()
   WHERE id = p_run_id
   RETURNING * INTO v_run;

  RETURN v_run;
END;
$function$;
