
-- C-HR-3: Two-level leave approval

ALTER TABLE public.leave_types
  ADD COLUMN IF NOT EXISTS requires_second_approval boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS second_approval_threshold_days numeric;

ALTER TABLE public.leave_requests DROP CONSTRAINT IF EXISTS leave_requests_status_check;
ALTER TABLE public.leave_requests
  ADD CONSTRAINT leave_requests_status_check
  CHECK (status = ANY (ARRAY['draft','pending','pending_second_approval','approved','rejected','cancelled']));

-- Helper: who may grant the second-level approval?
CREATE OR REPLACE FUNCTION public.user_can_approve_leave_level2(_user uuid, _org uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.user_roles ur
    WHERE ur.user_id = _user
      AND ur.organization_id = _org
      AND ur.is_active = true
      AND ur.role IN ('super_admin','owner','admin')
  );
$$;

GRANT EXECUTE ON FUNCTION public.user_can_approve_leave_level2(uuid,uuid) TO authenticated;

-- First-level approval
CREATE OR REPLACE FUNCTION public.approve_leave_request_level1(p_request_id uuid)
RETURNS public.leave_requests
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  r public.leave_requests;
  lt_requires boolean;
  lt_threshold numeric;
  v_user uuid := auth.uid();
  v_needs_l2 boolean;
  v_target text;
BEGIN
  IF v_user IS NULL THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO r FROM public.leave_requests WHERE id = p_request_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Leave request not found' USING ERRCODE = 'P0002';
  END IF;
  IF r.status <> 'pending' THEN
    RAISE EXCEPTION 'Leave request is %, expected pending', r.status USING ERRCODE = '22023';
  END IF;
  IF NOT public.user_has_module_permission(v_user, r.organization_id, 'leave', 'approve') THEN
    RAISE EXCEPTION 'Missing leave.approve permission' USING ERRCODE = '42501';
  END IF;

  SELECT requires_second_approval, second_approval_threshold_days
    INTO lt_requires, lt_threshold
  FROM public.leave_types WHERE id = r.leave_type_id;

  v_needs_l2 := COALESCE(lt_requires, false)
                AND (lt_threshold IS NULL OR r.days_requested >= lt_threshold);

  v_target := CASE WHEN v_needs_l2 THEN 'pending_second_approval' ELSE 'approved' END;

  UPDATE public.leave_requests
     SET status = v_target,
         first_approver_id = v_user,
         first_approval_at = now(),
         updated_at = now()
   WHERE id = p_request_id
   RETURNING * INTO r;

  INSERT INTO public.audit_logs(organization_id, business_id, user_id, action, entity_type, entity_id, new_values)
  VALUES (r.organization_id, r.business_id, v_user, 'leave.approve_level1', 'leave_request', r.id,
          jsonb_build_object('next_status', v_target, 'days_requested', r.days_requested,
                             'requires_second_approval', v_needs_l2));

  RETURN r;
END;
$$;

GRANT EXECUTE ON FUNCTION public.approve_leave_request_level1(uuid) TO authenticated;

-- Second-level approval (final)
CREATE OR REPLACE FUNCTION public.approve_leave_request_level2(p_request_id uuid)
RETURNS public.leave_requests
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  r public.leave_requests;
  v_user uuid := auth.uid();
BEGIN
  IF v_user IS NULL THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO r FROM public.leave_requests WHERE id = p_request_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Leave request not found' USING ERRCODE = 'P0002';
  END IF;
  IF r.status <> 'pending_second_approval' THEN
    RAISE EXCEPTION 'Leave request is %, expected pending_second_approval', r.status USING ERRCODE = '22023';
  END IF;
  IF r.first_approver_id IS NOT NULL AND r.first_approver_id = v_user THEN
    RAISE EXCEPTION 'Second-level approver must differ from first-level approver (maker-checker)' USING ERRCODE = '42501';
  END IF;
  IF NOT public.user_can_approve_leave_level2(v_user, r.organization_id) THEN
    RAISE EXCEPTION 'Missing leave.approve_level2 permission' USING ERRCODE = '42501';
  END IF;

  UPDATE public.leave_requests
     SET status = 'approved',
         second_approver_id = v_user,
         second_approval_at = now(),
         updated_at = now()
   WHERE id = p_request_id
   RETURNING * INTO r;

  INSERT INTO public.audit_logs(organization_id, business_id, user_id, action, entity_type, entity_id, new_values)
  VALUES (r.organization_id, r.business_id, v_user, 'leave.approve_level2', 'leave_request', r.id,
          jsonb_build_object('first_approver_id', r.first_approver_id, 'days_requested', r.days_requested));

  RETURN r;
END;
$$;

GRANT EXECUTE ON FUNCTION public.approve_leave_request_level2(uuid) TO authenticated;
