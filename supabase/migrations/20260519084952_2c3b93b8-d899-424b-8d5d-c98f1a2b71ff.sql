
-- =====================================================================
-- POS Payment Terminal — tenant integration points
-- Mirrors organization_payment_gateways + sms_provider_configs pattern.
-- =====================================================================

-- Enum for supported terminal vendors. Extensible via ALTER TYPE later.
DO $$ BEGIN
  CREATE TYPE public.pos_terminal_provider AS ENUM (
    'stripe_terminal',
    'adyen',
    'verifone',
    'square_terminal'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE public.pos_terminal_mode AS ENUM ('test', 'live');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ---------------------------------------------------------------------
-- pos_terminal_provider_configs
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.pos_terminal_provider_configs (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id   uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  business_id       uuid NOT NULL REFERENCES public.businesses(id)    ON DELETE CASCADE,
  branch_id         uuid REFERENCES public.branches(id) ON DELETE SET NULL,
  provider          public.pos_terminal_provider NOT NULL,
  provider_mode     public.pos_terminal_mode     NOT NULL DEFAULT 'test',
  display_name      text,
  is_enabled        boolean NOT NULL DEFAULT false,

  -- Non-secret vendor identifiers (safe to read masked).
  location_id       text,           -- Stripe Terminal location / Square location
  merchant_account  text,           -- Adyen merchant account / Verifone merchant id
  poi_terminal_id   text,           -- Adyen POI / Verifone serial / Square device id
  api_key_last4     text,           -- last 4 of the secret for the masked UI

  -- Secret material lives in Vault.
  vault_secret_id   uuid,

  -- Test/health tracking.
  last_test_at      timestamptz,
  last_test_status  text,
  last_test_error   text,

  created_by        uuid,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT pos_terminal_cfg_unique
    UNIQUE (organization_id, business_id, provider)
);

CREATE INDEX IF NOT EXISTS idx_pos_terminal_cfg_org
  ON public.pos_terminal_provider_configs (organization_id, business_id);

ALTER TABLE public.pos_terminal_provider_configs ENABLE ROW LEVEL SECURITY;

-- Direct table reads/writes are denied — go through the SECURITY DEFINER RPCs.
-- (No anon/auth policies. Service role bypasses RLS for the edge function.)
DROP POLICY IF EXISTS "no direct access to terminal configs" ON public.pos_terminal_provider_configs;
CREATE POLICY "no direct access to terminal configs"
  ON public.pos_terminal_provider_configs
  FOR ALL
  USING (false)
  WITH CHECK (false);

-- updated_at trigger (reuse global helper if present, else inline).
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc WHERE proname = 'update_updated_at_column'
  ) THEN
    CREATE OR REPLACE FUNCTION public.update_updated_at_column()
    RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $f$
    BEGIN
      NEW.updated_at = now();
      RETURN NEW;
    END;
    $f$;
  END IF;
END $$;

DROP TRIGGER IF EXISTS trg_pos_terminal_cfg_updated_at
  ON public.pos_terminal_provider_configs;
CREATE TRIGGER trg_pos_terminal_cfg_updated_at
BEFORE UPDATE ON public.pos_terminal_provider_configs
FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- ---------------------------------------------------------------------
-- pos_terminal_sessions  (audit + reconciliation per physical tap)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.pos_terminal_sessions (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id     uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  business_id         uuid NOT NULL REFERENCES public.businesses(id)    ON DELETE CASCADE,
  config_id           uuid REFERENCES public.pos_terminal_provider_configs(id) ON DELETE SET NULL,
  payment_request_id  uuid REFERENCES public.payment_requests(id) ON DELETE SET NULL,
  provider            public.pos_terminal_provider NOT NULL,
  terminal_serial     text,
  connection_id       text,
  intent_id           text,
  status              text NOT NULL DEFAULT 'initiated',
  vendor_response     jsonb,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_pos_terminal_sessions_payment
  ON public.pos_terminal_sessions (payment_request_id);
CREATE INDEX IF NOT EXISTS idx_pos_terminal_sessions_org
  ON public.pos_terminal_sessions (organization_id, business_id, created_at DESC);

ALTER TABLE public.pos_terminal_sessions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "members can read terminal sessions" ON public.pos_terminal_sessions;
CREATE POLICY "members can read terminal sessions"
  ON public.pos_terminal_sessions
  FOR SELECT
  TO authenticated
  USING (public.is_org_member(auth.uid(), organization_id));

DROP POLICY IF EXISTS "no client writes to terminal sessions" ON public.pos_terminal_sessions;
CREATE POLICY "no client writes to terminal sessions"
  ON public.pos_terminal_sessions
  FOR ALL
  USING (false) WITH CHECK (false);

DROP TRIGGER IF EXISTS trg_pos_terminal_sessions_updated_at
  ON public.pos_terminal_sessions;
CREATE TRIGGER trg_pos_terminal_sessions_updated_at
BEFORE UPDATE ON public.pos_terminal_sessions
FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- =====================================================================
-- RPC: get_terminal_config_masked
-- =====================================================================
CREATE OR REPLACE FUNCTION public.get_terminal_config_masked(
  p_organization_id uuid,
  p_business_id     uuid DEFAULT NULL
)
RETURNS TABLE (
  id                uuid,
  organization_id   uuid,
  business_id       uuid,
  branch_id         uuid,
  provider          public.pos_terminal_provider,
  provider_mode     public.pos_terminal_mode,
  display_name      text,
  is_enabled        boolean,
  location_id       text,
  merchant_account  text,
  poi_terminal_id   text,
  api_key_masked    text,
  has_secret        boolean,
  last_test_at      timestamptz,
  last_test_status  text,
  last_test_error   text,
  created_at        timestamptz,
  updated_at        timestamptz
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id uuid := auth.uid();
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '28000';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.user_roles ur
    WHERE ur.user_id = v_user_id
      AND ur.organization_id = p_organization_id
      AND ur.role IN ('owner', 'admin', 'super_admin')
  ) THEN
    RAISE EXCEPTION 'You do not have permission to view terminal configurations.'
      USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  SELECT
    c.id, c.organization_id, c.business_id, c.branch_id,
    c.provider, c.provider_mode, c.display_name, c.is_enabled,
    c.location_id, c.merchant_account, c.poi_terminal_id,
    CASE
      WHEN c.api_key_last4 IS NULL THEN NULL
      ELSE '••••••••' || c.api_key_last4
    END AS api_key_masked,
    (c.vault_secret_id IS NOT NULL) AS has_secret,
    c.last_test_at, c.last_test_status, c.last_test_error,
    c.created_at, c.updated_at
  FROM public.pos_terminal_provider_configs c
  WHERE c.organization_id = p_organization_id
    AND (p_business_id IS NULL OR c.business_id = p_business_id)
  ORDER BY c.provider;
END;
$$;

-- =====================================================================
-- RPC: set_terminal_provider_config
-- =====================================================================
CREATE OR REPLACE FUNCTION public.set_terminal_provider_config(
  p_organization_id uuid,
  p_business_id     uuid,
  p_provider        public.pos_terminal_provider,
  p_provider_mode   public.pos_terminal_mode,
  p_display_name    text,
  p_api_key         text,            -- raw secret (will be vaulted)
  p_location_id     text DEFAULT NULL,
  p_merchant_account text DEFAULT NULL,
  p_poi_terminal_id text DEFAULT NULL,
  p_branch_id       uuid DEFAULT NULL,
  p_is_enabled      boolean DEFAULT true
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'vault', 'extensions'
AS $$
DECLARE
  v_user_id          uuid := auth.uid();
  v_business_org     uuid;
  v_existing_id      uuid;
  v_existing_secret  uuid;
  v_new_secret_id    uuid;
  v_secret_name      text;
  v_last4            text;
  v_old jsonb;
  v_new jsonb;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '28000';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.user_roles ur
    WHERE ur.user_id = v_user_id
      AND ur.organization_id = p_organization_id
      AND ur.role IN ('owner', 'admin', 'super_admin')
  ) THEN
    RAISE EXCEPTION 'You do not have permission to configure POS terminals for this workspace.'
      USING ERRCODE = '42501';
  END IF;

  SELECT organization_id INTO v_business_org
  FROM public.businesses WHERE id = p_business_id;
  IF v_business_org IS NULL OR v_business_org <> p_organization_id THEN
    RAISE EXCEPTION 'Company does not belong to this workspace.' USING ERRCODE = '22023';
  END IF;

  IF p_api_key IS NULL OR length(p_api_key) < 8 OR length(p_api_key) > 1000 THEN
    RAISE EXCEPTION 'api_key must be between 8 and 1000 characters' USING ERRCODE = '22023';
  END IF;

  v_last4 := right(p_api_key, 4);

  SELECT id, vault_secret_id, to_jsonb(c)
    INTO v_existing_id, v_existing_secret, v_old
  FROM public.pos_terminal_provider_configs c
  WHERE organization_id = p_organization_id
    AND business_id     = p_business_id
    AND provider        = p_provider;

  v_secret_name := format('pos_terminal:%s:%s:%s', p_provider, p_organization_id, p_business_id);

  IF v_existing_secret IS NOT NULL THEN
    UPDATE vault.secrets
       SET secret = p_api_key, updated_at = now()
     WHERE id = v_existing_secret;
    v_new_secret_id := v_existing_secret;
  ELSE
    v_new_secret_id := vault.create_secret(
      p_api_key,
      v_secret_name,
      format('POS terminal %s credentials for org %s business %s',
             p_provider, p_organization_id, p_business_id)
    );
  END IF;

  IF v_existing_id IS NOT NULL THEN
    UPDATE public.pos_terminal_provider_configs
       SET provider_mode    = p_provider_mode,
           display_name     = p_display_name,
           location_id      = p_location_id,
           merchant_account = p_merchant_account,
           poi_terminal_id  = p_poi_terminal_id,
           branch_id        = p_branch_id,
           is_enabled       = p_is_enabled,
           vault_secret_id  = v_new_secret_id,
           api_key_last4    = v_last4,
           updated_at       = now()
     WHERE id = v_existing_id
    RETURNING to_jsonb(pos_terminal_provider_configs.*) INTO v_new;
  ELSE
    INSERT INTO public.pos_terminal_provider_configs (
      organization_id, business_id, branch_id, provider, provider_mode,
      display_name, location_id, merchant_account, poi_terminal_id,
      is_enabled, vault_secret_id, api_key_last4, created_by
    ) VALUES (
      p_organization_id, p_business_id, p_branch_id, p_provider, p_provider_mode,
      p_display_name, p_location_id, p_merchant_account, p_poi_terminal_id,
      p_is_enabled, v_new_secret_id, v_last4, v_user_id
    )
    RETURNING id, to_jsonb(pos_terminal_provider_configs.*) INTO v_existing_id, v_new;
  END IF;

  -- Audit (never log the api_key itself; v_new excludes it because it's not stored on the row).
  BEGIN
    INSERT INTO public.settings_audit_log (
      organization_id, business_id, branch_id, actor_id,
      setting_scope, setting_key, table_name, record_id,
      old_value, new_value, reason
    ) VALUES (
      p_organization_id, p_business_id, p_branch_id, v_user_id,
      'pos.terminal', p_provider::text,
      'pos_terminal_provider_configs', v_existing_id,
      v_old - 'vault_secret_id',
      v_new - 'vault_secret_id',
      'set_terminal_provider_config'
    );
  EXCEPTION WHEN OTHERS THEN
    -- Don't fail the write if the audit table shape drifts.
    NULL;
  END;

  RETURN v_existing_id;
END;
$$;

-- =====================================================================
-- RPC: delete_terminal_provider_config (row + vault secret atomically)
-- =====================================================================
CREATE OR REPLACE FUNCTION public.delete_terminal_provider_config(
  p_config_id uuid
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'vault', 'extensions'
AS $$
DECLARE
  v_user_id uuid := auth.uid();
  v_org     uuid;
  v_secret  uuid;
  v_business uuid;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '28000';
  END IF;

  SELECT organization_id, business_id, vault_secret_id
    INTO v_org, v_business, v_secret
  FROM public.pos_terminal_provider_configs
  WHERE id = p_config_id;

  IF v_org IS NULL THEN
    RETURN; -- already gone
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.user_roles ur
    WHERE ur.user_id = v_user_id
      AND ur.organization_id = v_org
      AND ur.role IN ('owner', 'admin', 'super_admin')
  ) THEN
    RAISE EXCEPTION 'You do not have permission to delete this terminal configuration.'
      USING ERRCODE = '42501';
  END IF;

  DELETE FROM public.pos_terminal_provider_configs WHERE id = p_config_id;

  IF v_secret IS NOT NULL THEN
    BEGIN
      DELETE FROM vault.secrets WHERE id = v_secret;
    EXCEPTION WHEN OTHERS THEN NULL; END;
  END IF;

  BEGIN
    INSERT INTO public.settings_audit_log (
      organization_id, business_id, actor_id, setting_scope, setting_key,
      table_name, record_id, reason
    ) VALUES (
      v_org, v_business, v_user_id, 'pos.terminal', 'delete',
      'pos_terminal_provider_configs', p_config_id, 'delete_terminal_provider_config'
    );
  EXCEPTION WHEN OTHERS THEN NULL; END;
END;
$$;

-- =====================================================================
-- RPC: record_terminal_test_result (called by edge function)
-- =====================================================================
CREATE OR REPLACE FUNCTION public.record_terminal_test_result(
  p_config_id uuid,
  p_status    text,
  p_error     text DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE public.pos_terminal_provider_configs
     SET last_test_at     = now(),
         last_test_status = p_status,
         last_test_error  = p_error,
         updated_at       = now()
   WHERE id = p_config_id;
END;
$$;

-- =====================================================================
-- Grants
-- =====================================================================
REVOKE ALL ON FUNCTION public.get_terminal_config_masked(uuid, uuid)         FROM PUBLIC;
REVOKE ALL ON FUNCTION public.set_terminal_provider_config(
  uuid, uuid, public.pos_terminal_provider, public.pos_terminal_mode,
  text, text, text, text, text, uuid, boolean
) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.delete_terminal_provider_config(uuid)          FROM PUBLIC;
REVOKE ALL ON FUNCTION public.record_terminal_test_result(uuid, text, text)  FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.get_terminal_config_masked(uuid, uuid)         TO authenticated;
GRANT EXECUTE ON FUNCTION public.set_terminal_provider_config(
  uuid, uuid, public.pos_terminal_provider, public.pos_terminal_mode,
  text, text, text, text, text, uuid, boolean
) TO authenticated;
GRANT EXECUTE ON FUNCTION public.delete_terminal_provider_config(uuid)          TO authenticated;
GRANT EXECUTE ON FUNCTION public.record_terminal_test_result(uuid, text, text)  TO service_role;
