
-- Drop old functions first to allow parameter changes
DROP FUNCTION IF EXISTS public.set_user_pin(text, text);
DROP FUNCTION IF EXISTS public.has_user_pin(text);

-- Recreate set_user_pin: user-level PIN (device fingerprint optional)
CREATE OR REPLACE FUNCTION public.set_user_pin(p_pin text, p_device_fingerprint text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id uuid;
  v_pin_hash text;
  v_pin_length int;
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

  v_pin_hash := crypt(p_pin, gen_salt('bf'));

  INSERT INTO public.user_pins (user_id, pin_hash, pin_length, device_fingerprint, is_active, failed_attempts)
  VALUES (v_user_id, v_pin_hash, v_pin_length, p_device_fingerprint, true, 0)
  ON CONFLICT (user_id) DO UPDATE SET
    pin_hash = v_pin_hash,
    pin_length = v_pin_length,
    device_fingerprint = COALESCE(p_device_fingerprint, public.user_pins.device_fingerprint),
    is_active = true,
    failed_attempts = 0,
    locked_until = NULL,
    updated_at = now();

  INSERT INTO public.user_security_preferences (user_id, pin_enabled)
  VALUES (v_user_id, true)
  ON CONFLICT (user_id) DO UPDATE SET pin_enabled = true, updated_at = now();

  RETURN jsonb_build_object('success', true, 'message', 'PIN set successfully');
END;
$$;

-- Recreate has_user_pin: user-level check (no device fingerprint needed)
CREATE OR REPLACE FUNCTION public.has_user_pin(p_device_fingerprint text DEFAULT NULL)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN EXISTS (
    SELECT 1 FROM public.user_pins
    WHERE user_id = auth.uid() AND is_active = true
  );
END;
$$;
