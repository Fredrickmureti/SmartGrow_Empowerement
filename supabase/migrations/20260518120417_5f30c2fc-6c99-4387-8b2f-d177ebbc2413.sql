
CREATE TABLE IF NOT EXISTS public.pos_scanner_pairings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token text NOT NULL UNIQUE,
  register_id uuid NOT NULL REFERENCES public.pos_registers(id) ON DELETE CASCADE,
  business_id uuid NOT NULL,
  branch_id uuid NOT NULL,
  organization_id uuid NOT NULL,
  session_id uuid,
  created_by uuid NOT NULL,
  expires_at timestamptz NOT NULL,
  claimed_at timestamptz,
  claimed_by_user uuid,
  claimed_device_label text,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_pos_scanner_pairings_token ON public.pos_scanner_pairings(token);
CREATE INDEX IF NOT EXISTS idx_pos_scanner_pairings_register ON public.pos_scanner_pairings(register_id);
CREATE INDEX IF NOT EXISTS idx_pos_scanner_pairings_org ON public.pos_scanner_pairings(organization_id);

ALTER TABLE public.pos_scanner_pairings ENABLE ROW LEVEL SECURITY;

CREATE POLICY "scanner_pairings_select_org"
  ON public.pos_scanner_pairings FOR SELECT
  TO authenticated
  USING (
    organization_id IN (
      SELECT organization_id FROM public.user_roles
       WHERE user_id = auth.uid() AND is_active = true
    )
  );

CREATE OR REPLACE FUNCTION public.pos_create_scanner_pairing(p_register_id uuid)
RETURNS TABLE(token text, expires_at timestamptz, register_id uuid)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
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

  SELECT s.id INTO v_session
    FROM public.pos_sessions s
   WHERE s.register_id = p_register_id
     AND s.status = 'active'
   ORDER BY s.started_at DESC
   LIMIT 1;

  v_token := encode(gen_random_bytes(24), 'base64');
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
SET search_path = public
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
