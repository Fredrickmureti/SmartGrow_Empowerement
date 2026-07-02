
-- Create a secure RPC for removing a PIN by device fingerprint
-- This replaces the direct table delete that bypasses RLS
CREATE OR REPLACE FUNCTION public.remove_user_pin_for_device(p_device_fingerprint TEXT)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id UUID;
  v_deleted_count INTEGER;
BEGIN
  v_user_id := auth.uid();
  
  IF v_user_id IS NULL THEN
    RETURN json_build_object('success', false, 'error', 'Not authenticated');
  END IF;

  DELETE FROM public.user_pins
  WHERE user_id = v_user_id
    AND device_fingerprint = p_device_fingerprint;

  GET DIAGNOSTICS v_deleted_count = ROW_COUNT;

  IF v_deleted_count = 0 THEN
    RETURN json_build_object('success', false, 'error', 'No PIN found for this device');
  END IF;

  RETURN json_build_object('success', true, 'message', 'PIN removed successfully');
END;
$$;
