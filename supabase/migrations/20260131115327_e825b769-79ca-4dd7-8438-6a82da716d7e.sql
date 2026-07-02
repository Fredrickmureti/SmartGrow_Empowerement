-- Fix PIN security functions to access pgcrypto in extensions schema
-- The gen_salt and crypt functions are in the 'extensions' schema, not 'public'

-- 1. Fix set_user_pin function
CREATE OR REPLACE FUNCTION public.set_user_pin(
  p_device_fingerprint TEXT,
  p_pin TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'extensions'
AS $$
DECLARE
  v_user_id UUID;
  v_pin_hash TEXT;
BEGIN
  v_user_id := auth.uid();
  IF v_user_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'Not authenticated');
  END IF;
  
  IF length(p_pin) < 4 OR length(p_pin) > 6 THEN
    RETURN jsonb_build_object('success', false, 'error', 'PIN must be 4-6 digits');
  END IF;
  
  IF p_pin !~ '^[0-9]+$' THEN
    RETURN jsonb_build_object('success', false, 'error', 'PIN must contain only numbers');
  END IF;
  
  IF p_pin ~ '^(.)\1+$' THEN
    RETURN jsonb_build_object('success', false, 'error', 'PIN cannot be all the same digit');
  END IF;
  
  IF p_pin IN ('1234', '12345', '123456', '0000', '00000', '000000', '1111', '11111', '111111') THEN
    RETURN jsonb_build_object('success', false, 'error', 'PIN is too common, please choose a stronger one');
  END IF;
  
  -- Now gen_salt and crypt will be found in extensions schema
  v_pin_hash := crypt(p_pin, gen_salt('bf', 10));
  
  INSERT INTO public.user_pins (user_id, device_fingerprint, pin_hash, pin_length)
  VALUES (v_user_id, p_device_fingerprint, v_pin_hash, length(p_pin))
  ON CONFLICT (user_id, device_fingerprint)
  DO UPDATE SET
    pin_hash = v_pin_hash,
    pin_length = length(p_pin),
    is_active = true,
    failed_attempts = 0,
    locked_until = NULL,
    updated_at = now();
  
  RETURN jsonb_build_object('success', true, 'message', 'PIN set successfully');
END;
$$;

-- 2. Fix verify_user_pin function (also uses crypt)
CREATE OR REPLACE FUNCTION public.verify_user_pin(
  p_device_fingerprint TEXT,
  p_pin TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'extensions'
AS $$
DECLARE
  v_user_id UUID;
  v_pin_record RECORD;
  v_is_valid BOOLEAN;
  v_max_attempts INTEGER := 5;
  v_lockout_minutes INTEGER := 15;
BEGIN
  v_user_id := auth.uid();
  IF v_user_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'Not authenticated', 'locked', false);
  END IF;
  
  SELECT * INTO v_pin_record
  FROM public.user_pins
  WHERE user_id = v_user_id
    AND device_fingerprint = p_device_fingerprint
    AND is_active = true;
  
  IF v_pin_record IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'No PIN set for this device', 'locked', false);
  END IF;
  
  IF v_pin_record.locked_until IS NOT NULL AND v_pin_record.locked_until > now() THEN
    RETURN jsonb_build_object(
      'success', false, 
      'error', 'Account temporarily locked. Try again later.',
      'locked', true,
      'locked_until', v_pin_record.locked_until
    );
  END IF;
  
  -- Now crypt will be found in extensions schema
  v_is_valid := v_pin_record.pin_hash = crypt(p_pin, v_pin_record.pin_hash);
  
  IF v_is_valid THEN
    UPDATE public.user_pins
    SET failed_attempts = 0, locked_until = NULL, last_used_at = now()
    WHERE id = v_pin_record.id;
    
    RETURN jsonb_build_object('success', true, 'message', 'PIN verified', 'locked', false);
  ELSE
    UPDATE public.user_pins
    SET 
      failed_attempts = failed_attempts + 1,
      locked_until = CASE 
        WHEN failed_attempts + 1 >= v_max_attempts 
        THEN now() + (v_lockout_minutes || ' minutes')::interval
        ELSE NULL
      END
    WHERE id = v_pin_record.id;
    
    IF v_pin_record.failed_attempts + 1 >= v_max_attempts THEN
      RETURN jsonb_build_object(
        'success', false, 
        'error', 'Too many failed attempts. Account locked for ' || v_lockout_minutes || ' minutes.',
        'locked', true,
        'attempts_remaining', 0
      );
    ELSE
      RETURN jsonb_build_object(
        'success', false, 
        'error', 'Invalid PIN',
        'locked', false,
        'attempts_remaining', v_max_attempts - (v_pin_record.failed_attempts + 1)
      );
    END IF;
  END IF;
END;
$$;

-- 3. Fix reset_user_pin for consistency (doesn't use pgcrypto but should have consistent search_path)
CREATE OR REPLACE FUNCTION public.reset_user_pin(
  p_device_fingerprint TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'extensions'
AS $$
DECLARE
  v_user_id UUID;
BEGIN
  v_user_id := auth.uid();
  IF v_user_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'Not authenticated');
  END IF;
  
  UPDATE public.user_pins
  SET is_active = false, updated_at = now()
  WHERE user_id = v_user_id
    AND device_fingerprint = p_device_fingerprint;
  
  RETURN jsonb_build_object('success', true, 'message', 'PIN reset successfully');
END;
$$;