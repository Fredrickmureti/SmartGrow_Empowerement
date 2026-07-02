CREATE OR REPLACE FUNCTION public.verify_pin_full(p_email text, p_pin text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id uuid;
  v_pin_result jsonb;
BEGIN
  SELECT p.user_id INTO v_user_id
  FROM profiles p
  JOIN user_security_preferences usp ON usp.user_id = p.user_id
  WHERE lower(p.email) = lower(p_email)
    AND usp.pin_enabled = true;

  IF v_user_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'Invalid credentials');
  END IF;

  SELECT public.verify_pin_unauthenticated(v_user_id, p_pin) INTO v_pin_result;
  RETURN v_pin_result;
END;
$$;