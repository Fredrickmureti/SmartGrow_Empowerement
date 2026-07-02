CREATE OR REPLACE FUNCTION public.set_user_pin(p_pin text, p_device_fingerprint text DEFAULT NULL::text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id uuid;
  v_pin_hash text;
  v_pin_length integer;
BEGIN
  v_user_id := auth.uid();

  IF v_user_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'Not authenticated');
  END IF;

  v_pin_length := length(p_pin);

  IF v_pin_length < 4 OR v_pin_length > 6 THEN
    RETURN jsonb_build_object('success', false, 'error', 'PIN must be 4-6 digits');
  END IF;

  IF p_pin !~ '^\d+$' THEN
    RETURN jsonb_build_object('success', false, 'error', 'PIN must contain only digits');
  END IF;

  v_pin_hash := extensions.crypt(p_pin, extensions.gen_salt('bf'));

  INSERT INTO public.user_pins (user_id, pin_hash, pin_length, device_fingerprint, is_active, failed_attempts)
  VALUES (v_user_id, v_pin_hash, v_pin_length, p_device_fingerprint, true, 0)
  ON CONFLICT (user_id) DO UPDATE SET
    pin_hash = EXCLUDED.pin_hash,
    pin_length = EXCLUDED.pin_length,
    device_fingerprint = COALESCE(EXCLUDED.device_fingerprint, public.user_pins.device_fingerprint),
    is_active = true,
    failed_attempts = 0,
    locked_until = NULL,
    last_used_at = NULL,
    updated_at = now();

  INSERT INTO public.user_security_preferences (user_id, pin_enabled)
  VALUES (v_user_id, true)
  ON CONFLICT (user_id) DO UPDATE
  SET pin_enabled = true, updated_at = now();

  RETURN jsonb_build_object('success', true, 'message', 'PIN set successfully');
END;
$$;

REVOKE ALL ON FUNCTION public.set_user_pin(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.set_user_pin(text, text) TO authenticated;

CREATE OR REPLACE FUNCTION public.verify_pin_unauthenticated(p_user_id uuid, p_pin text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_pin_hash text;
  v_failed_attempts integer;
  v_locked_until timestamptz;
  v_max_attempts integer := 5;
  v_lockout_minutes integer := 15;
BEGIN
  SELECT pin_hash, COALESCE(failed_attempts, 0), locked_until
  INTO v_pin_hash, v_failed_attempts, v_locked_until
  FROM public.user_pins
  WHERE user_id = p_user_id AND is_active = true;

  IF v_pin_hash IS NULL THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'No active PIN found'
    );
  END IF;

  IF v_locked_until IS NOT NULL AND v_locked_until > now() THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'PIN is temporarily locked',
      'locked', true,
      'locked_until', v_locked_until,
      'attempts_remaining', 0
    );
  END IF;

  IF extensions.crypt(p_pin, v_pin_hash) = v_pin_hash THEN
    UPDATE public.user_pins
    SET failed_attempts = 0,
        locked_until = NULL,
        last_used_at = now(),
        updated_at = now()
    WHERE user_id = p_user_id;

    RETURN jsonb_build_object('success', true);
  END IF;

  v_failed_attempts := v_failed_attempts + 1;

  IF v_failed_attempts >= v_max_attempts THEN
    v_locked_until := now() + make_interval(mins => v_lockout_minutes);

    UPDATE public.user_pins
    SET failed_attempts = v_failed_attempts,
        locked_until = v_locked_until,
        updated_at = now()
    WHERE user_id = p_user_id;

    RETURN jsonb_build_object(
      'success', false,
      'error', 'Too many failed attempts. PIN locked.',
      'locked', true,
      'locked_until', v_locked_until,
      'attempts_remaining', 0
    );
  END IF;

  UPDATE public.user_pins
  SET failed_attempts = v_failed_attempts,
      updated_at = now()
  WHERE user_id = p_user_id;

  RETURN jsonb_build_object(
    'success', false,
    'error', 'Invalid PIN',
    'locked', false,
    'attempts_remaining', GREATEST(v_max_attempts - v_failed_attempts, 0)
  );
END;
$$;

REVOKE ALL ON FUNCTION public.verify_pin_unauthenticated(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.verify_pin_unauthenticated(uuid, text) TO service_role;

TRUNCATE TABLE public.login_history, public.user_devices, public.user_pins CASCADE;

UPDATE public.user_security_preferences
SET pin_enabled = false,
    updated_at = now()
WHERE pin_enabled IS DISTINCT FROM false;