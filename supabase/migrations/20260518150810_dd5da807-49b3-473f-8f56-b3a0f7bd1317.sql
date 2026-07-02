CREATE OR REPLACE FUNCTION public.initiate_ownership_transfer(
  _to_user_id uuid,
  _notes text DEFAULT NULL
)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'extensions'
AS $$
DECLARE
  _from_user_id uuid;
  _transfer_id uuid;
  _token text;
  _existing_pending int;
BEGIN
  SELECT user_id INTO _from_user_id
  FROM platform_admins
  WHERE user_id = auth.uid() AND role = 'owner' AND is_active = true;

  IF _from_user_id IS NULL THEN
    RETURN json_build_object('success', false, 'error', 'Only the platform owner can initiate a transfer');
  END IF;

  IF _from_user_id = _to_user_id THEN
    RETURN json_build_object('success', false, 'error', 'Cannot transfer ownership to yourself');
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM platform_admins WHERE user_id = _to_user_id AND is_active = true
  ) THEN
    RETURN json_build_object('success', false, 'error', 'Target must be an active platform admin');
  END IF;

  SELECT count(*) INTO _existing_pending
  FROM platform_ownership_transfers
  WHERE status IN ('pending', 'verified') AND from_user_id = _from_user_id;

  IF _existing_pending > 0 THEN
    RETURN json_build_object('success', false, 'error', 'A pending transfer already exists. Cancel it first.');
  END IF;

  _token := encode(extensions.gen_random_bytes(32), 'hex');
  _transfer_id := gen_random_uuid();

  INSERT INTO platform_ownership_transfers (
    id, from_user_id, to_user_id, initiated_by, initiated_at,
    verification_token, status, expires_at, notes
  ) VALUES (
    _transfer_id, _from_user_id, _to_user_id, _from_user_id, now(),
    _token, 'pending', now() + interval '72 hours', _notes
  );

  INSERT INTO admin_audit_log (admin_user_id, action_type, details)
  VALUES (_from_user_id, 'ownership_transfer_initiated', json_build_object(
    'transfer_id', _transfer_id,
    'to_user_id', _to_user_id
  ));

  RETURN json_build_object(
    'success', true,
    'transfer_id', _transfer_id,
    'token', _token,
    'expires_at', (now() + interval '72 hours')::text
  );
END;
$$;