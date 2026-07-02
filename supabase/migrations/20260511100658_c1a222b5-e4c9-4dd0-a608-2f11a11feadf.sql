CREATE OR REPLACE FUNCTION public.process_pos_drawer_event(
  p_register_id uuid,
  p_shift_id uuid,
  p_reason text,
  p_transaction_id uuid DEFAULT NULL,
  p_reason_note text DEFAULT NULL,
  p_hardware_success boolean DEFAULT NULL,
  p_hardware_result jsonb DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_org_id uuid;
  v_business_id uuid;
  v_branch_id uuid;
  v_event_id uuid;
  v_user uuid := auth.uid();
BEGIN
  IF v_user IS NULL THEN
    RAISE EXCEPTION 'unauthenticated' USING ERRCODE = '28000';
  END IF;

  SELECT organization_id, business_id, branch_id
    INTO v_org_id, v_business_id, v_branch_id
  FROM public.pos_registers
  WHERE id = p_register_id;

  IF v_org_id IS NULL THEN
    RAISE EXCEPTION 'register not found' USING ERRCODE = 'P0002';
  END IF;

  -- Caller must have access to this business.
  IF NOT EXISTS (
    SELECT 1 FROM public.user_business_access
    WHERE business_id = v_business_id AND user_id = v_user
  ) THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501';
  END IF;

  INSERT INTO public.pos_drawer_events (
    organization_id, business_id, branch_id, register_id, shift_id,
    transaction_id, reason, reason_note, triggered_by, triggered_at,
    hardware_success, hardware_result
  ) VALUES (
    v_org_id, v_business_id, v_branch_id, p_register_id, p_shift_id,
    p_transaction_id, p_reason, p_reason_note, v_user, now(),
    p_hardware_success,
    COALESCE(p_hardware_result, '{}'::jsonb)
  )
  RETURNING id INTO v_event_id;

  RETURN v_event_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.process_pos_drawer_event(uuid, uuid, text, uuid, text, boolean, jsonb) TO authenticated;