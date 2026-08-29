-- 1) has_user_pin(): does the signed-in user have an active PIN?
CREATE OR REPLACE FUNCTION public.has_user_pin()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.user_pins
    WHERE user_id = auth.uid() AND is_active = true
  );
$$;

REVOKE ALL ON FUNCTION public.has_user_pin() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.has_user_pin() TO authenticated, service_role;

-- 2) check_pin_status(p_email): login screen probe — is PIN login available for this email?
CREATE OR REPLACE FUNCTION public.check_pin_status(p_email text)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id uuid;
  v_pin_length integer;
  v_enabled boolean;
BEGIN
  IF p_email IS NULL OR btrim(p_email) = '' THEN
    RETURN jsonb_build_object('has_pin', false, 'pin_length', 0);
  END IF;

  SELECT p.user_id INTO v_user_id
    FROM public.profiles p
   WHERE lower(p.email) = lower(btrim(p_email))
   LIMIT 1;

  IF v_user_id IS NULL THEN
    RETURN jsonb_build_object('has_pin', false, 'pin_length', 0);
  END IF;

  SELECT up.pin_length INTO v_pin_length
    FROM public.user_pins up
   WHERE up.user_id = v_user_id
     AND up.is_active = true
     AND (up.locked_until IS NULL OR up.locked_until <= now());

  SELECT COALESCE(sp.pin_enabled, false) INTO v_enabled
    FROM public.user_security_preferences sp
   WHERE sp.user_id = v_user_id;

  IF v_pin_length IS NULL OR COALESCE(v_enabled, false) = false THEN
    RETURN jsonb_build_object('has_pin', false, 'pin_length', 0);
  END IF;

  RETURN jsonb_build_object('has_pin', true, 'pin_length', v_pin_length);
END;
$$;

REVOKE ALL ON FUNCTION public.check_pin_status(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.check_pin_status(text) TO anon, authenticated, service_role;

-- 3) verify_pin_full(p_email, p_pin): backend-only email+PIN verification for the pin-login function.
CREATE OR REPLACE FUNCTION public.verify_pin_full(p_email text, p_pin text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id uuid;
  v_enabled boolean;
  v_result jsonb;
BEGIN
  IF p_email IS NULL OR p_pin IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'Email and PIN are required');
  END IF;

  SELECT p.user_id INTO v_user_id
    FROM public.profiles p
   WHERE lower(p.email) = lower(btrim(p_email))
   LIMIT 1;

  IF v_user_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'Invalid credentials');
  END IF;

  SELECT COALESCE(sp.pin_enabled, false) INTO v_enabled
    FROM public.user_security_preferences sp
   WHERE sp.user_id = v_user_id;

  IF COALESCE(v_enabled, false) = false THEN
    RETURN jsonb_build_object('success', false, 'error', 'PIN login is not enabled for this account');
  END IF;

  v_result := public.verify_pin_unauthenticated(v_user_id, p_pin);

  IF COALESCE((v_result->>'success')::boolean, false) THEN
    v_result := v_result || jsonb_build_object('user_id', v_user_id);
  END IF;

  RETURN v_result;
END;
$$;

REVOKE ALL ON FUNCTION public.verify_pin_full(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.verify_pin_full(text, text) TO service_role;