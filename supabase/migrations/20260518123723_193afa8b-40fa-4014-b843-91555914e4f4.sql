-- Fix: gen_random_bytes lives in the `extensions` schema in Supabase, but the
-- POS scanner pairing RPCs set search_path = public, so the unqualified call
-- raised `function gen_random_bytes(integer) does not exist` every time a
-- cashier clicked "Phone" in the terminal. Re-create the functions with the
-- extensions schema in search_path AND fully-qualify the call as a belt-and-
-- braces fix.

CREATE OR REPLACE FUNCTION public.pos_create_scanner_pairing(p_register_id uuid)
RETURNS TABLE(token text, expires_at timestamptz, register_id uuid)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_user uuid := auth.uid();
  v_reg record;
  v_token text;
  v_expires timestamptz := now() + interval '60 seconds';
  v_session uuid;
BEGIN
  IF v_user IS NULL THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '28000';
  END IF;

  SELECT r.id, r.organization_id, r.business_id, r.branch_id
    INTO v_reg
    FROM public.pos_registers r
   WHERE r.id = p_register_id;

  IF v_reg.id IS NULL THEN
    RAISE EXCEPTION 'Register not found' USING ERRCODE = 'P0002';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.user_roles
     WHERE user_id = v_user
       AND organization_id = v_reg.organization_id
       AND is_active = true
  ) THEN
    RAISE EXCEPTION 'Not authorized for this register' USING ERRCODE = '42501';
  END IF;

  IF v_reg.branch_id IS NOT NULL
     AND NOT public.user_can_access_branch(v_user, v_reg.branch_id) THEN
    RAISE EXCEPTION 'Not authorized for branch %', v_reg.branch_id
      USING ERRCODE = '42501';
  END IF;

  SELECT s.id INTO v_session
    FROM public.pos_sessions s
   WHERE s.register_id = p_register_id
     AND s.status = 'active'
   ORDER BY s.started_at DESC
   LIMIT 1;

  v_token := encode(extensions.gen_random_bytes(24), 'base64');
  v_token := replace(replace(replace(v_token, '+', '-'), '/', '_'), '=', '');

  INSERT INTO public.pos_scanner_pairings (
    token, register_id, business_id, branch_id, organization_id,
    session_id, created_by, expires_at
  ) VALUES (
    v_token, v_reg.id, v_reg.business_id, v_reg.branch_id, v_reg.organization_id,
    v_session, v_user, v_expires
  );

  RETURN QUERY SELECT v_token, v_expires, v_reg.id;
END;
$$;
REVOKE ALL ON FUNCTION public.pos_create_scanner_pairing(uuid) FROM public;
GRANT EXECUTE ON FUNCTION public.pos_create_scanner_pairing(uuid) TO authenticated;

-- Also widen search_path on the sibling RPCs for consistency, so any future
-- pgcrypto use (HMAC of tokens, etc.) resolves without surprise.
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
  v_pair record;
  v_reg_name text;
BEGIN
  IF v_user IS NULL THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '28000';
  END IF;

  SELECT * INTO v_pair FROM public.pos_scanner_pairings p
   WHERE p.token = p_token FOR UPDATE;

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
    SELECT 1 FROM public.user_roles
     WHERE user_id = v_user
       AND organization_id = v_pair.organization_id
       AND is_active = true
  ) THEN
    RAISE EXCEPTION 'Not authorized for this register' USING ERRCODE = '42501';
  END IF;

  IF v_pair.branch_id IS NOT NULL
     AND NOT public.user_can_access_branch(v_user, v_pair.branch_id) THEN
    RAISE EXCEPTION 'Not authorized for branch %', v_pair.branch_id
      USING ERRCODE = '42501';
  END IF;

  UPDATE public.pos_scanner_pairings
     SET claimed_at = now(),
         claimed_by_user = v_user,
         claimed_device_label = p_device_label
   WHERE id = v_pair.id;

  SELECT register_name INTO v_reg_name FROM public.pos_registers WHERE id = v_pair.register_id;

  RETURN QUERY SELECT
    v_pair.register_id,
    v_pair.business_id,
    v_pair.branch_id,
    v_pair.organization_id,
    v_pair.session_id,
    'pos:scan:' || v_pair.register_id::text,
    v_reg_name;
END;
$$;
REVOKE ALL ON FUNCTION public.pos_claim_scanner_pairing(text, text) FROM public;
GRANT EXECUTE ON FUNCTION public.pos_claim_scanner_pairing(text, text) TO authenticated;

CREATE OR REPLACE FUNCTION public.pos_revoke_scanner_pairing(p_register_id uuid)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_user uuid := auth.uid();
  v_reg record;
  v_count integer;
BEGIN
  IF v_user IS NULL THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '28000';
  END IF;

  SELECT id, organization_id, branch_id INTO v_reg
    FROM public.pos_registers WHERE id = p_register_id;
  IF v_reg.id IS NULL THEN
    RAISE EXCEPTION 'Register not found' USING ERRCODE = 'P0002';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.user_roles
     WHERE user_id = v_user AND organization_id = v_reg.organization_id AND is_active = true
  ) THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = '42501';
  END IF;
  IF v_reg.branch_id IS NOT NULL
     AND NOT public.user_can_access_branch(v_user, v_reg.branch_id) THEN
    RAISE EXCEPTION 'Not authorized for branch %', v_reg.branch_id USING ERRCODE = '42501';
  END IF;

  UPDATE public.pos_scanner_pairings
     SET revoked_at = now()
   WHERE register_id = p_register_id
     AND revoked_at IS NULL;
  GET DIAGNOSTICS v_count = ROW_COUNT;

  RETURN v_count;
END;
$$;
REVOKE ALL ON FUNCTION public.pos_revoke_scanner_pairing(uuid) FROM public;
GRANT EXECUTE ON FUNCTION public.pos_revoke_scanner_pairing(uuid) TO authenticated;