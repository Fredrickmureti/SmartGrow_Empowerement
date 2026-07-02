-- Create anonymous-accessible function to check if PIN exists for a user+device
-- This allows showing the PIN login form even when user is logged out

CREATE OR REPLACE FUNCTION public.check_pin_exists(
  p_user_id UUID,
  p_device_fingerprint TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  RETURN jsonb_build_object(
    'exists', EXISTS (
      SELECT 1 FROM public.user_pins
      WHERE user_id = p_user_id
        AND device_fingerprint = p_device_fingerprint
        AND is_active = true
        AND (locked_until IS NULL OR locked_until < now())
    ),
    'pin_length', (
      SELECT pin_length FROM public.user_pins
      WHERE user_id = p_user_id
        AND device_fingerprint = p_device_fingerprint
        AND is_active = true
      LIMIT 1
    )
  );
END;
$$;

-- Grant execute permission to anonymous users so this works without auth
GRANT EXECUTE ON FUNCTION public.check_pin_exists(UUID, TEXT) TO anon;
GRANT EXECUTE ON FUNCTION public.check_pin_exists(UUID, TEXT) TO authenticated;