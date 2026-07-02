-- Fix ambiguity: RETURNS TABLE OUT params (organization_id, branch_id, business_id,
-- register_id, session_id) shadow column names inside the function body, so the
-- unqualified `organization_id = v_pair.organization_id` in the user_roles
-- EXISTS check raises "column reference organization_id is ambiguous" when the
-- phone calls pos_claim_scanner_pairing. Qualify every reference.

CREATE OR REPLACE FUNCTION public.pos_claim_scanner_pairing(
  p_token text,
  p_device_label text DEFAULT NULL
)
RETURNS TABLE(
  register_id uuid,
  business_id uuid,
  branch_id uuid,
  organization_id uuid,
  session_id uuid,
  channel_key text,
  register_name text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_user uuid := auth.uid();
  v_pair public.pos_scanner_pairings%ROWTYPE;
  v_reg_name text;
BEGIN
  IF v_user IS NULL THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '28000';
  END IF;

  SELECT p.* INTO v_pair
    FROM public.pos_scanner_pairings p
   WHERE p.token = p_token
   FOR UPDATE;

  IF v_pair.id IS NULL THEN
    RAISE EXCEPTION 'Invalid pairing token' USING ERRCODE = 'P0002';
  END IF;
  IF v_pair.claimed_at IS NOT NULL OR v_pair.revoked_at IS NOT NULL THEN
    RAISE EXCEPTION 'Pairing token already used' USING ERRCODE = '22023';
  END IF;
  IF v_pair.expires_at < now() THEN
    RAISE EXCEPTION 'Pairing token expired' USING ERRCODE = '22023';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.user_roles ur
     WHERE ur.user_id = v_user
       AND ur.organization_id = v_pair.organization_id
       AND ur.is_active = true
  ) THEN
    RAISE EXCEPTION 'Not authorized for this register' USING ERRCODE = '42501';
  END IF;

  IF v_pair.branch_id IS NOT NULL
     AND NOT public.user_can_access_branch(v_user, v_pair.branch_id) THEN
    RAISE EXCEPTION 'Not authorized for branch %', v_pair.branch_id
      USING ERRCODE = '42501';
  END IF;

  UPDATE public.pos_scanner_pairings p
     SET claimed_at = now(),
         claimed_by_user = v_user,
         claimed_device_label = p_device_label
   WHERE p.id = v_pair.id;

  SELECT r.register_name INTO v_reg_name
    FROM public.pos_registers r
   WHERE r.id = v_pair.register_id;

  RETURN QUERY SELECT
    v_pair.register_id,
    v_pair.business_id,
    v_pair.branch_id,
    v_pair.organization_id,
    v_pair.session_id,
    ('pos:scan:' || v_pair.register_id::text)::text,
    v_reg_name;
END;
$$;

REVOKE ALL ON FUNCTION public.pos_claim_scanner_pairing(text, text) FROM public;
GRANT EXECUTE ON FUNCTION public.pos_claim_scanner_pairing(text, text) TO authenticated;