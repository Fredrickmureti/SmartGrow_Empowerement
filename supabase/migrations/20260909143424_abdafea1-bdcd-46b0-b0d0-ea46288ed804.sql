CREATE OR REPLACE FUNCTION public.mf_register_client(
  p_business_id uuid,
  p_client jsonb,
  p_group_id uuid DEFAULT NULL::uuid,
  p_meeting_id uuid DEFAULT NULL::uuid
)
RETURNS public.mf_clients
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_branch uuid := (p_client->>'branch_id')::uuid;
  v_officer uuid := NULLIF(p_client->>'loan_officer_id','')::uuid;
  v_group RECORD;
  v_meeting RECORD;
  v_client public.mf_clients;
BEGIN
  IF v_branch IS NULL THEN
    RAISE EXCEPTION 'Choose the branch that will own this client.' USING ERRCODE = 'P0001';
  END IF;

  IF v_officer IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.user_branch_assignments a
     WHERE a.user_id = v_officer
       AND a.business_id = p_business_id
       AND a.branch_id = v_branch
  ) THEN
    RAISE EXCEPTION 'This loan officer is not assigned to the selected branch.'
      USING ERRCODE = 'P0001';
  END IF;

  IF p_group_id IS NOT NULL THEN
    SELECT business_id, branch_id, loan_officer_id, status INTO v_group
      FROM public.mf_groups WHERE id = p_group_id;
    IF NOT FOUND OR v_group.business_id IS DISTINCT FROM p_business_id THEN
      RAISE EXCEPTION 'That group is not available in this institution.' USING ERRCODE = 'P0001';
    END IF;
    IF v_group.branch_id IS DISTINCT FROM v_branch THEN
      RAISE EXCEPTION 'This group belongs to a different branch than the client.' USING ERRCODE = 'P0001';
    END IF;
    IF v_group.status = 'closed' THEN
      RAISE EXCEPTION 'This group is closed and cannot take new members.' USING ERRCODE = 'P0001';
    END IF;
    IF v_officer IS NOT NULL AND v_group.loan_officer_id IS NOT NULL
       AND v_group.loan_officer_id IS DISTINCT FROM v_officer THEN
      RAISE EXCEPTION 'This group is managed by a different loan officer.' USING ERRCODE = 'P0001';
    END IF;
  END IF;

  IF p_meeting_id IS NOT NULL THEN
    SELECT business_id, group_id, status INTO v_meeting
      FROM public.mf_group_meetings WHERE id = p_meeting_id;
    IF NOT FOUND OR v_meeting.business_id IS DISTINCT FROM p_business_id THEN
      RAISE EXCEPTION 'That meeting is not available in this institution.' USING ERRCODE = 'P0001';
    END IF;
    IF p_group_id IS NOT NULL AND v_meeting.group_id IS DISTINCT FROM p_group_id THEN
      RAISE EXCEPTION 'That meeting belongs to a different group.' USING ERRCODE = 'P0001';
    END IF;
    IF v_meeting.status NOT IN ('scheduled','in_progress') THEN
      RAISE EXCEPTION 'This meeting is already closed, so no new client can be recorded against it.'
        USING ERRCODE = 'P0001';
    END IF;
  END IF;

  INSERT INTO public.mf_clients (
    business_id, branch_id, client_number, full_name, national_id, date_of_birth,
    gender, phone, email, physical_address, occupation, business_type,
    business_location, next_of_kin_name, next_of_kin_relationship,
    next_of_kin_phone, loan_officer_id, status, notes, onboarded_meeting_id, created_by
  ) VALUES (
    p_business_id,
    v_branch,
    COALESCE(NULLIF(p_client->>'client_number',''), ''),
    p_client->>'full_name',
    NULLIF(p_client->>'national_id',''),
    NULLIF(p_client->>'date_of_birth','')::date,
    NULLIF(p_client->>'gender',''),
    NULLIF(p_client->>'phone',''),
    NULLIF(p_client->>'email',''),
    NULLIF(p_client->>'physical_address',''),
    NULLIF(p_client->>'occupation',''),
    NULLIF(p_client->>'business_type',''),
    NULLIF(p_client->>'business_location',''),
    NULLIF(p_client->>'next_of_kin_name',''),
    NULLIF(p_client->>'next_of_kin_relationship',''),
    NULLIF(p_client->>'next_of_kin_phone',''),
    v_officer,
    COALESCE(NULLIF(p_client->>'status',''), 'prospect'),
    NULLIF(p_client->>'notes',''),
    p_meeting_id,
    auth.uid()
  )
  RETURNING * INTO v_client;

  IF p_group_id IS NOT NULL THEN
    INSERT INTO public.mf_group_members (business_id, group_id, client_id, role_in_group)
    VALUES (p_business_id, p_group_id, v_client.id, 'member');
  END IF;

  RETURN v_client;
END;
$function$;

REVOKE ALL ON FUNCTION public.mf_register_client(uuid, jsonb, uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.mf_register_client(uuid, jsonb, uuid, uuid) TO authenticated, service_role;