-- Enterprise Fiscalization Core — Deliverable 1

-- 1) fiscal_transmissions
CREATE TABLE IF NOT EXISTS public.fiscal_transmissions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  business_id uuid,
  branch_id uuid,
  provider_key text NOT NULL,
  document_kind text NOT NULL,
  source_doc_type text NOT NULL,
  source_doc_id uuid NOT NULL,
  sequence_no integer NOT NULL DEFAULT 1,
  idempotency_key text NOT NULL,
  state text NOT NULL DEFAULT 'queued'
    CHECK (state IN ('queued','transmitting','succeeded','rejected','retry_scheduled','failed','dead_letter','superseded')),
  attempt_count integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz,
  request_payload jsonb,
  response_payload jsonb,
  fiscal_number text,
  signature text,
  qr_data text,
  control_unit_id text,
  transmitted_at timestamptz,
  superseded_by uuid REFERENCES public.fiscal_transmissions(id) ON DELETE SET NULL,
  last_error text,
  event_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT fiscal_transmissions_idem_unique UNIQUE (organization_id, provider_key, idempotency_key)
);
CREATE INDEX IF NOT EXISTS idx_fiscal_transmissions_org_state ON public.fiscal_transmissions (organization_id, state, next_attempt_at);
CREATE INDEX IF NOT EXISTS idx_fiscal_transmissions_source ON public.fiscal_transmissions (source_doc_type, source_doc_id);
CREATE INDEX IF NOT EXISTS idx_fiscal_transmissions_provider ON public.fiscal_transmissions (provider_key, state);
GRANT SELECT ON public.fiscal_transmissions TO authenticated;
GRANT ALL ON public.fiscal_transmissions TO service_role;
ALTER TABLE public.fiscal_transmissions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users can read fiscal transmissions for their org"
  ON public.fiscal_transmissions FOR SELECT TO authenticated
  USING (organization_id IN (SELECT organization_id FROM public.user_business_access WHERE user_id = auth.uid()));
CREATE POLICY "Service role manages fiscal transmissions"
  ON public.fiscal_transmissions FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE OR REPLACE FUNCTION public.fiscal_transmissions_touch()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = public AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END $$;
CREATE TRIGGER fiscal_transmissions_touch BEFORE UPDATE ON public.fiscal_transmissions
  FOR EACH ROW EXECUTE FUNCTION public.fiscal_transmissions_touch();

-- 2) Circuit breaker
CREATE TABLE IF NOT EXISTS public.fiscal_provider_circuit (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  provider_key text NOT NULL,
  state text NOT NULL DEFAULT 'closed' CHECK (state IN ('closed','open','half_open')),
  consecutive_failures integer NOT NULL DEFAULT 0,
  opened_at timestamptz,
  next_probe_at timestamptz,
  last_error text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, provider_key)
);
GRANT SELECT ON public.fiscal_provider_circuit TO authenticated;
GRANT ALL ON public.fiscal_provider_circuit TO service_role;
ALTER TABLE public.fiscal_provider_circuit ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users read circuit state for their org"
  ON public.fiscal_provider_circuit FOR SELECT TO authenticated
  USING (organization_id IN (SELECT organization_id FROM public.user_business_access WHERE user_id = auth.uid()));
CREATE POLICY "Service role manages circuit state"
  ON public.fiscal_provider_circuit FOR ALL TO service_role USING (true) WITH CHECK (true);

-- 3) Pack fiscal providers
CREATE TABLE IF NOT EXISTS public.localization_pack_fiscal_providers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pack_id uuid NOT NULL REFERENCES public.localization_packs(id) ON DELETE CASCADE,
  pack_version_id uuid REFERENCES public.pack_versions(id) ON DELETE SET NULL,
  provider_key text NOT NULL,
  provider_name text NOT NULL,
  authority_id uuid REFERENCES public.statutory_authorities(id),
  endpoint_edge_function text NOT NULL,
  sandbox_url text NOT NULL,
  production_url text NOT NULL,
  pin_regex text,
  doc_type_map jsonb NOT NULL DEFAULT '{}'::jsonb,
  payment_type_map jsonb NOT NULL DEFAULT '{}'::jsonb,
  tax_category_map jsonb NOT NULL DEFAULT '{}'::jsonb,
  receipt_footer_legal_text text,
  qr_url_template text,
  legal_reference text,
  effective_date date,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (pack_id, provider_key)
);
GRANT SELECT ON public.localization_pack_fiscal_providers TO authenticated;
GRANT ALL ON public.localization_pack_fiscal_providers TO service_role;
ALTER TABLE public.localization_pack_fiscal_providers ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Anyone authenticated reads pack fiscal providers"
  ON public.localization_pack_fiscal_providers FOR SELECT TO authenticated USING (true);
CREATE POLICY "Service role manages pack fiscal providers"
  ON public.localization_pack_fiscal_providers FOR ALL TO service_role USING (true) WITH CHECK (true);

-- 4) Pack fiscal code maps
CREATE TABLE IF NOT EXISTS public.localization_pack_fiscal_code_maps (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pack_id uuid NOT NULL REFERENCES public.localization_packs(id) ON DELETE CASCADE,
  pack_version_id uuid REFERENCES public.pack_versions(id) ON DELETE SET NULL,
  provider_key text NOT NULL,
  code_type text NOT NULL,
  code text NOT NULL,
  name text NOT NULL,
  parent_code text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  effective_date date,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (pack_id, provider_key, code_type, code)
);
CREATE INDEX IF NOT EXISTS idx_pack_fiscal_code_maps_lookup ON public.localization_pack_fiscal_code_maps (provider_key, code_type, code);
GRANT SELECT ON public.localization_pack_fiscal_code_maps TO authenticated;
GRANT ALL ON public.localization_pack_fiscal_code_maps TO service_role;
ALTER TABLE public.localization_pack_fiscal_code_maps ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Anyone authenticated reads pack fiscal code maps"
  ON public.localization_pack_fiscal_code_maps FOR SELECT TO authenticated USING (true);
CREATE POLICY "Service role manages pack fiscal code maps"
  ON public.localization_pack_fiscal_code_maps FOR ALL TO service_role USING (true) WITH CHECK (true);

-- 5) Fiscal device credentials
CREATE TABLE IF NOT EXISTS public.fiscal_device_credentials (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  business_id uuid NOT NULL,
  branch_id uuid,
  provider_key text NOT NULL,
  device_serial text,
  branch_office_id text,
  tax_pin text,
  communication_key_encrypted text,
  environment text NOT NULL DEFAULT 'sandbox' CHECK (environment IN ('sandbox','production')),
  is_active boolean NOT NULL DEFAULT true,
  initialized_at timestamptz,
  credential_rotated_at timestamptz,
  credential_expires_at timestamptz,
  last_health_check_at timestamptz,
  last_health_ok boolean,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, business_id, branch_id, provider_key)
);
GRANT SELECT ON public.fiscal_device_credentials TO authenticated;
GRANT ALL ON public.fiscal_device_credentials TO service_role;
ALTER TABLE public.fiscal_device_credentials ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users read fiscal creds for their org"
  ON public.fiscal_device_credentials FOR SELECT TO authenticated
  USING (organization_id IN (SELECT organization_id FROM public.user_business_access WHERE user_id = auth.uid()));
CREATE POLICY "Service role manages fiscal creds"
  ON public.fiscal_device_credentials FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE TRIGGER fiscal_device_credentials_touch BEFORE UPDATE ON public.fiscal_device_credentials
  FOR EACH ROW EXECUTE FUNCTION public.fiscal_transmissions_touch();

-- 6) Register fiscal_provider rule type
INSERT INTO public.pack_rule_type_schemas (rule_type, computation_kind, json_schema, description)
VALUES (
  'fiscal_provider',
  'metadata',
  '{"type":"object","required":["provider_key","endpoint_edge_function","doc_type_map","payment_type_map","tax_category_map"],"properties":{"provider_key":{"type":"string"},"endpoint_edge_function":{"type":"string"},"sandbox_url":{"type":"string"},"production_url":{"type":"string"},"pin_regex":{"type":"string"},"doc_type_map":{"type":"object"},"payment_type_map":{"type":"object"},"tax_category_map":{"type":"object"},"receipt_footer_legal_text":{"type":"string"}}}'::jsonb,
  'Fiscal compliance provider mapping (KRA eTIMS, ZRA Smart, EFRIS, etc.)'
)
ON CONFLICT (rule_type, computation_kind, schema_version) DO UPDATE
SET json_schema = EXCLUDED.json_schema, description = EXCLUDED.description;

-- 7) Enqueue helper
CREATE OR REPLACE FUNCTION public.enqueue_fiscal_receipt_required(
  p_org_id uuid, p_business_id uuid, p_branch_id uuid,
  p_source_doc_type text, p_source_doc_id uuid,
  p_document_kind text, p_payload jsonb
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_provider_key text; v_event_id uuid;
BEGIN
  SELECT fp.provider_key INTO v_provider_key
  FROM public.installed_localization_packs ilp
  JOIN public.localization_pack_fiscal_providers fp ON fp.pack_id = ilp.pack_id
  WHERE ilp.organization_id = p_org_id
  LIMIT 1;
  IF v_provider_key IS NULL THEN RETURN NULL; END IF;
  INSERT INTO public.business_event_outbox (
    org_id, branch_id, event_type, source_doc_type, source_doc_id, payload
  ) VALUES (
    p_org_id, p_branch_id, 'fiscal.receipt_required', p_source_doc_type, p_source_doc_id,
    p_payload || jsonb_build_object('document_kind', p_document_kind, 'provider_key', v_provider_key)
  ) RETURNING id INTO v_event_id;
  RETURN v_event_id;
END $$;
GRANT EXECUTE ON FUNCTION public.enqueue_fiscal_receipt_required(uuid,uuid,uuid,text,uuid,text,jsonb) TO authenticated, service_role;

COMMENT ON TABLE public.fiscal_transmissions IS
  'Provider-agnostic fiscal transmission ledger for the enterprise fiscalization pipeline.';
COMMENT ON TABLE public.localization_pack_fiscal_providers IS
  'Localization-pack-owned fiscal-provider metadata. Kenya pack publishes kra_etims here; core has zero Kenya knowledge.';