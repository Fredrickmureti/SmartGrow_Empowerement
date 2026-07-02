
-- 1. Schema changes
ALTER TABLE public.ai_api_keys
  ADD COLUMN IF NOT EXISTS vault_secret_id uuid;

ALTER TABLE public.ai_api_keys
  ALTER COLUMN api_key_encrypted DROP NOT NULL;

-- 2. Migrate existing plaintext keys into Vault
DO $$
DECLARE
  r RECORD;
  v_secret_id uuid;
  v_name text;
BEGIN
  FOR r IN
    SELECT id, api_key_encrypted
    FROM public.ai_api_keys
    WHERE vault_secret_id IS NULL
      AND api_key_encrypted IS NOT NULL
  LOOP
    v_name := 'ai_api_key_' || r.id::text;
    SELECT vault.create_secret(r.api_key_encrypted, v_name,
                               'AI provider API key (migrated from plaintext column)')
      INTO v_secret_id;
    UPDATE public.ai_api_keys
       SET vault_secret_id = v_secret_id,
           api_key_encrypted = NULL
     WHERE id = r.id;
  END LOOP;
END $$;

-- 3. RPC: store a new AI API key (platform admins only)
CREATE OR REPLACE FUNCTION public.store_ai_api_key(
  p_provider_id uuid,
  p_key_name    text,
  p_api_key     text,
  p_priority    integer DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_secret_id uuid;
  v_row_id    uuid;
  v_priority  integer;
BEGIN
  IF NOT public.is_platform_admin(auth.uid()) THEN
    RAISE EXCEPTION 'Forbidden: platform admin required';
  END IF;

  IF p_api_key IS NULL OR length(btrim(p_api_key)) = 0 THEN
    RAISE EXCEPTION 'API key must not be empty';
  END IF;
  IF p_key_name IS NULL OR length(btrim(p_key_name)) = 0 THEN
    RAISE EXCEPTION 'Key name must not be empty';
  END IF;

  v_row_id := gen_random_uuid();

  SELECT vault.create_secret(
           p_api_key,
           'ai_api_key_' || v_row_id::text,
           'AI provider API key'
         )
    INTO v_secret_id;

  IF p_priority IS NULL THEN
    SELECT COALESCE(MAX(priority), 0) + 1
      INTO v_priority
      FROM public.ai_api_keys
     WHERE provider_id = p_provider_id;
  ELSE
    v_priority := p_priority;
  END IF;

  INSERT INTO public.ai_api_keys (
    id, provider_id, key_name, api_key_encrypted, vault_secret_id, priority
  ) VALUES (
    v_row_id, p_provider_id, p_key_name, NULL, v_secret_id, v_priority
  );

  RETURN v_row_id;
END;
$$;

REVOKE ALL ON FUNCTION public.store_ai_api_key(uuid, text, text, integer) FROM public;
GRANT EXECUTE ON FUNCTION public.store_ai_api_key(uuid, text, text, integer) TO authenticated;

-- 4. RPC: delete an AI API key (platform admins only) — removes Vault secret too
CREATE OR REPLACE FUNCTION public.delete_ai_api_key(p_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_secret_id uuid;
BEGIN
  IF NOT public.is_platform_admin(auth.uid()) THEN
    RAISE EXCEPTION 'Forbidden: platform admin required';
  END IF;

  SELECT vault_secret_id INTO v_secret_id
    FROM public.ai_api_keys
   WHERE id = p_id;

  DELETE FROM public.ai_api_keys WHERE id = p_id;

  IF v_secret_id IS NOT NULL THEN
    DELETE FROM vault.secrets WHERE id = v_secret_id;
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.delete_ai_api_key(uuid) FROM public;
GRANT EXECUTE ON FUNCTION public.delete_ai_api_key(uuid) TO authenticated;

-- 5. RPC: resolve plaintext (service role only — used by edge functions)
CREATE OR REPLACE FUNCTION public.get_ai_api_key_secret(p_id uuid)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_secret_id uuid;
  v_secret    text;
BEGIN
  -- Only the service role may resolve plaintext secrets.
  IF current_setting('request.jwt.claims', true)::jsonb->>'role' IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'Forbidden: service role required';
  END IF;

  SELECT vault_secret_id INTO v_secret_id
    FROM public.ai_api_keys
   WHERE id = p_id AND is_enabled = true;

  IF v_secret_id IS NULL THEN
    RETURN NULL;
  END IF;

  SELECT decrypted_secret INTO v_secret
    FROM vault.decrypted_secrets
   WHERE id = v_secret_id;

  RETURN v_secret;
END;
$$;

REVOKE ALL ON FUNCTION public.get_ai_api_key_secret(uuid) FROM public;
GRANT EXECUTE ON FUNCTION public.get_ai_api_key_secret(uuid) TO service_role;
