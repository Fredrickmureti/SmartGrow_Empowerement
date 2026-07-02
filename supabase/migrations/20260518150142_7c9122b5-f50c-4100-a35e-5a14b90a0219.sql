-- Fix gen_random_bytes search_path in scanner-session pairing RPC.
-- pgcrypto lives in the `extensions` schema in Supabase; SECURITY DEFINER
-- with SET search_path = public hides it. Same fix already applied to
-- pos_create_scanner_pairing in 20260518123723 — this completes the pattern.

CREATE OR REPLACE FUNCTION public.create_scanner_session_pairing(
  p_session_id uuid
) RETURNS TABLE(token text, expires_at timestamptz, session_id uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_s record;
  v_token text;
  v_exp timestamptz := now() + interval '60 seconds';
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501'; END IF;

  SELECT * INTO v_s FROM public.scanner_sessions WHERE id = p_session_id;
  IF v_s.id IS NULL THEN RAISE EXCEPTION 'session not found' USING ERRCODE = '42704'; END IF;
  IF v_s.revoked_at IS NOT NULL OR v_s.expires_at < now() THEN
    RAISE EXCEPTION 'session inactive' USING ERRCODE = '22023';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.user_roles ur
    WHERE ur.user_id = v_uid AND ur.organization_id = v_s.organization_id AND ur.is_active = true
  ) THEN
    RAISE EXCEPTION 'No access' USING ERRCODE = '42501';
  END IF;

  IF v_s.branch_id IS NOT NULL AND NOT public.user_can_access_branch(v_uid, v_s.branch_id) THEN
    RAISE EXCEPTION 'No branch access' USING ERRCODE = '42501';
  END IF;

  v_token := encode(extensions.gen_random_bytes(24), 'base64');
  v_token := translate(v_token, '+/=', '-_');

  INSERT INTO public.scanner_session_pairings(
    token, session_id, business_id, branch_id, organization_id, created_by, expires_at
  ) VALUES (
    v_token, v_s.id, v_s.business_id, v_s.branch_id, v_s.organization_id, v_uid, v_exp
  );

  RETURN QUERY SELECT v_token, v_exp, v_s.id;
END $$;

REVOKE ALL ON FUNCTION public.create_scanner_session_pairing(uuid) FROM public;
GRANT EXECUTE ON FUNCTION public.create_scanner_session_pairing(uuid) TO authenticated;

-- Migration B: product_identifiers ON CONFLICT shape.
-- Replace expression unique indexes on lower(code) with a generated stored
-- column + plain unique constraints so PostgREST's on_conflict=col,col,col
-- inference works. Read path (pos_resolve_barcode) already lowercases, so
-- uniqueness semantics are preserved.

ALTER TABLE public.product_identifiers
  ADD COLUMN IF NOT EXISTS code_norm text
  GENERATED ALWAYS AS (lower(code)) STORED;

DROP INDEX IF EXISTS public.product_identifiers_business_code_kind_uidx;
DROP INDEX IF EXISTS public.product_identifiers_business_code_uidx;

-- Plain unique constraints so PostgREST on_conflict by column name works.
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.product_identifiers'::regclass
      AND conname = 'product_identifiers_business_code_norm_kind_key'
  ) THEN
    ALTER TABLE public.product_identifiers
      ADD CONSTRAINT product_identifiers_business_code_norm_kind_key
      UNIQUE (business_id, code_norm, kind);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.product_identifiers'::regclass
      AND conname = 'product_identifiers_business_code_norm_key'
  ) THEN
    ALTER TABLE public.product_identifiers
      ADD CONSTRAINT product_identifiers_business_code_norm_key
      UNIQUE (business_id, code_norm);
  END IF;
END $$;