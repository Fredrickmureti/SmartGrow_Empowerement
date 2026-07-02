
-- Gap 1: Add pin_enabled column
ALTER TABLE public.user_security_preferences
  ADD COLUMN IF NOT EXISTS pin_enabled BOOLEAN NOT NULL DEFAULT false;

-- Gap 4: Migrate user_pins to user-level unique constraint
ALTER TABLE public.user_pins
  ALTER COLUMN device_fingerprint DROP NOT NULL;

-- Drop old compound unique constraint (try both possible names)
DO $$
BEGIN
  ALTER TABLE public.user_pins DROP CONSTRAINT IF EXISTS user_pins_user_id_device_fingerprint_key;
  ALTER TABLE public.user_pins DROP CONSTRAINT IF EXISTS user_pins_user_id_device_fingerprint_idx;
EXCEPTION WHEN OTHERS THEN NULL;
END $$;

-- Deduplicate: keep only the most recent PIN per user before adding unique constraint
DELETE FROM public.user_pins a
USING public.user_pins b
WHERE a.user_id = b.user_id
  AND a.created_at < b.created_at;

-- Add user-level unique constraint
ALTER TABLE public.user_pins
  ADD CONSTRAINT user_pins_user_id_key UNIQUE (user_id);

-- Gap 2: check_pin_status (anon-callable, anti-enumeration)
CREATE OR REPLACE FUNCTION public.check_pin_status(p_email text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id uuid;
  v_pin_length integer;
  v_pin_enabled boolean;
BEGIN
  -- Look up user by email
  SELECT p.user_id INTO v_user_id
  FROM public.profiles p
  WHERE lower(p.email) = lower(p_email);

  IF v_user_id IS NULL THEN
    -- Anti-enumeration: same response as "no PIN"
    RETURN jsonb_build_object('has_pin', false, 'pin_length', 0);
  END IF;

  -- Check if PIN is enabled in preferences
  SELECT pin_enabled INTO v_pin_enabled
  FROM public.user_security_preferences
  WHERE user_id = v_user_id;

  IF NOT COALESCE(v_pin_enabled, false) THEN
    RETURN jsonb_build_object('has_pin', false, 'pin_length', 0);
  END IF;

  -- Check if active PIN exists
  SELECT pin_length INTO v_pin_length
  FROM public.user_pins
  WHERE user_id = v_user_id AND is_active = true;

  IF v_pin_length IS NULL THEN
    RETURN jsonb_build_object('has_pin', false, 'pin_length', 0);
  END IF;

  RETURN jsonb_build_object('has_pin', true, 'pin_length', v_pin_length);
END;
$$;

-- Grant anon access
GRANT EXECUTE ON FUNCTION public.check_pin_status(text) TO anon;
GRANT EXECUTE ON FUNCTION public.check_pin_status(text) TO authenticated;

-- Gap 3: verify_pin_unauthenticated (service_role only)
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
  -- Get current PIN record
  SELECT pin_hash, failed_attempts, locked_until
  INTO v_pin_hash, v_failed_attempts, v_locked_until
  FROM public.user_pins
  WHERE user_id = p_user_id AND is_active = true;

  IF v_pin_hash IS NULL THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'No active PIN found'
    );
  END IF;

  -- Check lockout
  IF v_locked_until IS NOT NULL AND v_locked_until > now() THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'Account is temporarily locked due to too many failed attempts',
      'locked', true,
      'locked_until', v_locked_until::text,
      'attempts_remaining', 0
    );
  END IF;

  -- Clear expired lockout
  IF v_locked_until IS NOT NULL AND v_locked_until <= now() THEN
    UPDATE public.user_pins
    SET failed_attempts = 0, locked_until = NULL
    WHERE user_id = p_user_id AND is_active = true;
    v_failed_attempts := 0;
  END IF;

  -- Verify PIN hash using bcrypt
  IF v_pin_hash = crypt(p_pin, v_pin_hash) THEN
    -- Success: reset failed attempts, update last_used_at
    UPDATE public.user_pins
    SET failed_attempts = 0, locked_until = NULL, last_used_at = now()
    WHERE user_id = p_user_id AND is_active = true;

    RETURN jsonb_build_object('success', true);
  ELSE
    -- Failed: increment attempts
    v_failed_attempts := COALESCE(v_failed_attempts, 0) + 1;

    IF v_failed_attempts >= v_max_attempts THEN
      UPDATE public.user_pins
      SET failed_attempts = v_failed_attempts,
          locked_until = now() + (v_lockout_minutes || ' minutes')::interval
      WHERE user_id = p_user_id AND is_active = true;

      RETURN jsonb_build_object(
        'success', false,
        'error', 'Too many failed attempts. Account locked for ' || v_lockout_minutes || ' minutes.',
        'locked', true,
        'locked_until', (now() + (v_lockout_minutes || ' minutes')::interval)::text,
        'attempts_remaining', 0
      );
    ELSE
      UPDATE public.user_pins
      SET failed_attempts = v_failed_attempts
      WHERE user_id = p_user_id AND is_active = true;

      RETURN jsonb_build_object(
        'success', false,
        'error', 'Invalid PIN',
        'locked', false,
        'attempts_remaining', v_max_attempts - v_failed_attempts
      );
    END IF;
  END IF;
END;
$$;

-- Only service_role should call this (via edge function)
REVOKE EXECUTE ON FUNCTION public.verify_pin_unauthenticated(uuid, text) FROM anon;
REVOKE EXECUTE ON FUNCTION public.verify_pin_unauthenticated(uuid, text) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.verify_pin_unauthenticated(uuid, text) TO service_role;

-- Gap 5: Drop old device-based functions
DROP FUNCTION IF EXISTS public.remove_user_pin_for_device(text);
DROP FUNCTION IF EXISTS public.verify_user_pin(text, text);
