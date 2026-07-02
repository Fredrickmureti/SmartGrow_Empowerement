
-- ============================================================
-- POS Phone-as-Scanner hardening (G1, G3, G5, G6, G7)
-- ============================================================

-- ---- G6: table hardening -----------------------------------
ALTER TABLE public.pos_scanner_pairings
  DROP CONSTRAINT IF EXISTS pos_scanner_pairings_expires_after_created;
ALTER TABLE public.pos_scanner_pairings
  ADD CONSTRAINT pos_scanner_pairings_expires_after_created
  CHECK (expires_at > created_at);

CREATE INDEX IF NOT EXISTS idx_pos_scanner_pairings_active
  ON public.pos_scanner_pairings(register_id)
  WHERE claimed_at IS NULL AND revoked_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_pos_scanner_pairings_claimed_active
  ON public.pos_scanner_pairings(register_id)
  WHERE claimed_at IS NOT NULL AND revoked_at IS NULL;

-- Explicit deny direct mutations from authenticated/anon; only SECURITY DEFINER
-- RPCs may write. We do this by adding restrictive policies that always fail.
DROP POLICY IF EXISTS "scanner_pairings_no_direct_insert" ON public.pos_scanner_pairings;
CREATE POLICY "scanner_pairings_no_direct_insert"
  ON public.pos_scanner_pairings AS RESTRICTIVE FOR INSERT
  TO authenticated, anon
  WITH CHECK (false);

DROP POLICY IF EXISTS "scanner_pairings_no_direct_update" ON public.pos_scanner_pairings;
CREATE POLICY "scanner_pairings_no_direct_update"
  ON public.pos_scanner_pairings AS RESTRICTIVE FOR UPDATE
  TO authenticated, anon
  USING (false) WITH CHECK (false);

DROP POLICY IF EXISTS "scanner_pairings_no_direct_delete" ON public.pos_scanner_pairings;
CREATE POLICY "scanner_pairings_no_direct_delete"
  ON public.pos_scanner_pairings AS RESTRICTIVE FOR DELETE
  TO authenticated, anon
  USING (false);

-- ---- G3: branch-scoped create + claim ----------------------
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

  -- Org membership AND branch access (POS branch isolation)
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

-- ---- G5: revoke RPC ----------------------------------------
CREATE OR REPLACE FUNCTION public.pos_revoke_scanner_pairing(p_register_id uuid)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
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

-- ---- G1: Realtime Authorization on pos:scan:* private channels ----
-- A user may read/send broadcasts on `pos:scan:<register_id>` iff:
--   * they are authenticated
--   * the register exists
--   * they have an active user_roles row in its organization
--   * they have branch access to its branch
-- This is enforced via RLS on realtime.messages.

CREATE OR REPLACE FUNCTION public.can_access_pos_scan_channel(p_topic text)
RETURNS boolean
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_register_id uuid;
  v_reg record;
BEGIN
  IF v_uid IS NULL THEN RETURN false; END IF;
  IF p_topic IS NULL OR position('pos:scan:' in p_topic) <> 1 THEN
    RETURN false;
  END IF;
  BEGIN
    v_register_id := substring(p_topic from 10)::uuid;
  EXCEPTION WHEN others THEN
    RETURN false;
  END;
  SELECT organization_id, branch_id INTO v_reg
    FROM public.pos_registers WHERE id = v_register_id;
  IF v_reg.organization_id IS NULL THEN RETURN false; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.user_roles
     WHERE user_id = v_uid AND organization_id = v_reg.organization_id AND is_active = true
  ) THEN RETURN false; END IF;
  IF v_reg.branch_id IS NOT NULL
     AND NOT public.user_can_access_branch(v_uid, v_reg.branch_id) THEN
    RETURN false;
  END IF;
  RETURN true;
END;
$$;
GRANT EXECUTE ON FUNCTION public.can_access_pos_scan_channel(text) TO authenticated;

ALTER TABLE realtime.messages ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "pos_scan_channel_read" ON realtime.messages;
CREATE POLICY "pos_scan_channel_read"
  ON realtime.messages FOR SELECT
  TO authenticated
  USING (
    (realtime.topic() LIKE 'pos:scan:%')
    AND public.can_access_pos_scan_channel(realtime.topic())
  );

DROP POLICY IF EXISTS "pos_scan_channel_write" ON realtime.messages;
CREATE POLICY "pos_scan_channel_write"
  ON realtime.messages FOR INSERT
  TO authenticated
  WITH CHECK (
    (realtime.topic() LIKE 'pos:scan:%')
    AND public.can_access_pos_scan_channel(realtime.topic())
  );

-- ---- G7: daily purge of expired/old pairings via pg_cron ----
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname='pg_cron') THEN
    PERFORM cron.unschedule('pos-scanner-pairings-purge')
      WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname='pos-scanner-pairings-purge');
    PERFORM cron.schedule(
      'pos-scanner-pairings-purge',
      '17 3 * * *',
      $cron$ DELETE FROM public.pos_scanner_pairings
              WHERE expires_at < now() - interval '24 hours' $cron$
    );
  END IF;
END$$;
