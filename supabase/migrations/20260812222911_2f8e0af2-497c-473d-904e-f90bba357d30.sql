
-- ── Step 9: provider credential hardening ────────────────────────────────
-- 1. Non-secret credential metadata so the UI can show configured state.
ALTER TABLE public.platform_integration_connections
  ADD COLUMN IF NOT EXISTS credential_keys text[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS credentials_set_at timestamptz;

CREATE OR REPLACE FUNCTION public.sync_integration_credential_meta()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  NEW.credential_keys := COALESCE(
    (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(COALESCE(NEW.credentials, '{}'::jsonb)) k),
    '{}'::text[]
  );
  IF TG_OP = 'INSERT' THEN
    IF NEW.credentials IS DISTINCT FROM '{}'::jsonb THEN
      NEW.credentials_set_at := now();
    END IF;
  ELSIF NEW.credentials IS DISTINCT FROM OLD.credentials THEN
    NEW.credentials_set_at := now();
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_integration_credential_meta ON public.platform_integration_connections;
CREATE TRIGGER trg_integration_credential_meta
  BEFORE INSERT OR UPDATE ON public.platform_integration_connections
  FOR EACH ROW EXECUTE FUNCTION public.sync_integration_credential_meta();

UPDATE public.platform_integration_connections SET updated_at = updated_at;

-- 2. Secrets become server-only: no column-level access for API roles.
REVOKE ALL ON public.platform_integration_connections FROM anon, authenticated;

GRANT SELECT (
  id, capability_key, provider_id, display_label, is_active, config,
  auto_refresh_enabled, auto_refresh_interval_hours,
  last_test_at, last_test_ok, last_test_message,
  last_run_at, last_run_status, last_run_message, next_run_at,
  created_by, created_at, updated_at, credential_keys, credentials_set_at
) ON public.platform_integration_connections TO authenticated;

GRANT ALL ON public.platform_integration_connections TO service_role;

-- 3. Single guarded write path. Blank/absent values keep the stored secret.
CREATE OR REPLACE FUNCTION public.save_integration_connection(
  p_capability_key text,
  p_provider_id uuid,
  p_credentials jsonb DEFAULT '{}'::jsonb,
  p_id uuid DEFAULT NULL,
  p_auto_refresh_enabled boolean DEFAULT false,
  p_auto_refresh_interval_hours integer DEFAULT 24,
  p_activate boolean DEFAULT false,
  p_display_label text DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_id uuid := p_id;
  v_existing jsonb := '{}'::jsonb;
  v_merged jsonb := '{}'::jsonb;
  v_key text;
  v_val text;
BEGIN
  IF NOT public.is_platform_admin(auth.uid()) THEN
    RAISE EXCEPTION 'Not authorised to manage integration connections'
      USING ERRCODE = '42501';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.platform_integration_providers
    WHERE id = p_provider_id AND capability_key = p_capability_key
  ) THEN
    RAISE EXCEPTION 'Unknown provider for capability %', p_capability_key
      USING ERRCODE = '22023';
  END IF;

  IF v_id IS NOT NULL THEN
    SELECT credentials INTO v_existing
    FROM public.platform_integration_connections
    WHERE id = v_id AND capability_key = p_capability_key;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Connection % not found for capability %', v_id, p_capability_key
        USING ERRCODE = 'P0002';
    END IF;
  END IF;

  v_merged := COALESCE(v_existing, '{}'::jsonb);
  FOR v_key, v_val IN
    SELECT key, value #>> '{}' FROM jsonb_each(COALESCE(p_credentials, '{}'::jsonb))
  LOOP
    IF v_val IS NULL OR btrim(v_val) = '' THEN
      CONTINUE; -- blank means "keep what is stored"
    END IF;
    v_merged := v_merged || jsonb_build_object(v_key, v_val);
  END LOOP;

  IF p_activate THEN
    UPDATE public.platform_integration_connections
       SET is_active = false
     WHERE capability_key = p_capability_key
       AND (v_id IS NULL OR id <> v_id);
  END IF;

  IF v_id IS NULL THEN
    INSERT INTO public.platform_integration_connections (
      capability_key, provider_id, display_label, is_active, credentials,
      auto_refresh_enabled, auto_refresh_interval_hours, created_by
    ) VALUES (
      p_capability_key, p_provider_id, p_display_label, COALESCE(p_activate, false), v_merged,
      COALESCE(p_auto_refresh_enabled, false), COALESCE(p_auto_refresh_interval_hours, 24), auth.uid()
    )
    RETURNING id INTO v_id;
  ELSE
    UPDATE public.platform_integration_connections
       SET provider_id = p_provider_id,
           display_label = COALESCE(p_display_label, display_label),
           is_active = COALESCE(p_activate, is_active),
           credentials = v_merged,
           auto_refresh_enabled = COALESCE(p_auto_refresh_enabled, auto_refresh_enabled),
           auto_refresh_interval_hours = COALESCE(p_auto_refresh_interval_hours, auto_refresh_interval_hours)
     WHERE id = v_id;
  END IF;

  INSERT INTO public.audit_logs (user_id, action, entity_type, entity_id, metadata)
  VALUES (
    auth.uid(),
    CASE WHEN p_id IS NULL THEN 'integration_connection_created' ELSE 'integration_connection_updated' END,
    'platform_integration_connection',
    v_id,
    jsonb_build_object(
      'capability_key', p_capability_key,
      'provider_id', p_provider_id,
      'credential_fields_changed', (
        SELECT COALESCE(array_agg(key ORDER BY key), '{}')
        FROM jsonb_each_text(COALESCE(p_credentials, '{}'::jsonb))
        WHERE btrim(COALESCE(value, '')) <> ''
      ),
      'activated', COALESCE(p_activate, false)
    )
  );

  RETURN v_id;
END;
$$;

REVOKE ALL ON FUNCTION public.save_integration_connection(text, uuid, jsonb, uuid, boolean, integer, boolean, text) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.save_integration_connection(text, uuid, jsonb, uuid, boolean, integer, boolean, text) TO authenticated;

CREATE OR REPLACE FUNCTION public.delete_integration_connection(p_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_capability text;
BEGIN
  IF NOT public.is_platform_admin(auth.uid()) THEN
    RAISE EXCEPTION 'Not authorised to manage integration connections'
      USING ERRCODE = '42501';
  END IF;

  SELECT capability_key INTO v_capability
  FROM public.platform_integration_connections WHERE id = p_id;
  IF NOT FOUND THEN
    RETURN;
  END IF;

  DELETE FROM public.platform_integration_connections WHERE id = p_id;

  INSERT INTO public.audit_logs (user_id, action, entity_type, entity_id, metadata)
  VALUES (auth.uid(), 'integration_connection_deleted', 'platform_integration_connection', p_id,
          jsonb_build_object('capability_key', v_capability));
END;
$$;

REVOKE ALL ON FUNCTION public.delete_integration_connection(uuid) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.delete_integration_connection(uuid) TO authenticated;
