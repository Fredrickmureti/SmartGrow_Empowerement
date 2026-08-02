-- =====================================================================
-- ADR 0105 — Packaging Master, Phase 4 (GS1 / SSCC-18 identification)
-- =====================================================================

-- ---------------------------------------------------------------------
-- 0) Enums
-- ---------------------------------------------------------------------
DO $$ BEGIN
  CREATE TYPE public.wms_sscc_entity AS ENUM ('carton', 'lpn', 'pallet', 'manifest');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE public.wms_sscc_status AS ENUM ('assigned', 'voided');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ---------------------------------------------------------------------
-- 1) GS1 mod-10 check digit (GTIN-8/12/13/14, SSCC-18, GSIN, SSCC serials)
--    Input: numeric body WITHOUT the check digit.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.gs1_check_digit(p_body text)
RETURNS integer
LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
  v_body text := regexp_replace(COALESCE(p_body, ''), '\s', '', 'g');
  v_sum  integer := 0;
  v_i    integer;
  v_pos  integer;
BEGIN
  IF v_body !~ '^[0-9]+$' THEN
    RAISE EXCEPTION 'GS1_INVALID_BODY: digits only, got %', p_body;
  END IF;
  -- Weight alternates 3,1,3,1... starting from the RIGHTMOST body digit.
  FOR v_i IN 1..length(v_body) LOOP
    v_pos := length(v_body) - v_i;              -- 0 = rightmost
    v_sum := v_sum + substr(v_body, v_i, 1)::int * CASE WHEN v_pos % 2 = 0 THEN 3 ELSE 1 END;
  END LOOP;
  RETURN (10 - (v_sum % 10)) % 10;
END; $$;

REVOKE ALL ON FUNCTION public.gs1_check_digit(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.gs1_check_digit(text) TO authenticated, service_role;

-- SSCC-18 = extension digit (1) + company prefix (7..10) + serial reference + check digit
CREATE OR REPLACE FUNCTION public.wms_sscc_build(
  p_company_prefix text, p_extension_digit smallint, p_serial bigint
) RETURNS text
LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
  v_prefix text := regexp_replace(COALESCE(p_company_prefix, ''), '\s', '', 'g');
  v_ext    text;
  v_serial_len integer;
  v_body   text;
BEGIN
  IF v_prefix !~ '^[0-9]{6,10}$' THEN
    RAISE EXCEPTION 'GS1_INVALID_PREFIX: company prefix must be 6-10 digits';
  END IF;
  IF p_extension_digit IS NULL OR p_extension_digit < 0 OR p_extension_digit > 9 THEN
    RAISE EXCEPTION 'GS1_INVALID_EXTENSION: extension digit must be 0-9';
  END IF;
  v_ext := p_extension_digit::text;
  v_serial_len := 17 - 1 - length(v_prefix);
  IF p_serial IS NULL OR p_serial < 0 OR p_serial > (power(10, v_serial_len)::bigint - 1) THEN
    RAISE EXCEPTION 'GS1_SERIAL_EXHAUSTED: serial % does not fit in % digits', p_serial, v_serial_len;
  END IF;
  v_body := v_ext || v_prefix || lpad(p_serial::text, v_serial_len, '0');
  RETURN v_body || public.gs1_check_digit(v_body)::text;
END; $$;

REVOKE ALL ON FUNCTION public.wms_sscc_build(text, smallint, bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.wms_sscc_build(text, smallint, bigint) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.wms_sscc_is_valid(p_sscc text)
RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN p_sscc IS NULL OR p_sscc !~ '^[0-9]{18}$' THEN false
    ELSE substr(p_sscc, 18, 1)::int = public.gs1_check_digit(substr(p_sscc, 1, 17))
  END;
$$;

REVOKE ALL ON FUNCTION public.wms_sscc_is_valid(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.wms_sscc_is_valid(text) TO authenticated, service_role, anon;

-- ---------------------------------------------------------------------
-- 2) Per-business GS1 configuration (server-owned serial counter)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.wms_gs1_config (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id    uuid NOT NULL,
  business_id        uuid NOT NULL UNIQUE,
  company_prefix     text NOT NULL,
  extension_digit    smallint NOT NULL DEFAULT 0,
  sscc_next_serial   bigint NOT NULL DEFAULT 1,
  label_format       text NOT NULL DEFAULT 'gs1_128',
  is_enabled         boolean NOT NULL DEFAULT true,
  notes              text,
  row_version        integer NOT NULL DEFAULT 1,
  created_by         uuid,
  updated_by         uuid,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT wms_gs1_config_prefix_chk    CHECK (company_prefix ~ '^[0-9]{6,10}$'),
  CONSTRAINT wms_gs1_config_extension_chk CHECK (extension_digit BETWEEN 0 AND 9),
  CONSTRAINT wms_gs1_config_serial_chk    CHECK (sscc_next_serial >= 0),
  CONSTRAINT wms_gs1_config_format_chk    CHECK (label_format IN ('gs1_128', 'gs1_datamatrix', 'gs1_qr'))
);

GRANT SELECT ON public.wms_gs1_config TO authenticated;
GRANT ALL    ON public.wms_gs1_config TO service_role;
ALTER TABLE public.wms_gs1_config ENABLE ROW LEVEL SECURITY;

CREATE POLICY "wms_gs1_config_select" ON public.wms_gs1_config FOR SELECT TO authenticated
  USING (public.user_can_access_business(auth.uid(), business_id));

-- ---------------------------------------------------------------------
-- 3) SSCC registry — one row per issued code, never recycled
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.wms_sscc_registry (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id   uuid NOT NULL,
  business_id       uuid NOT NULL,
  sscc              text NOT NULL,
  serial_reference  bigint NOT NULL,
  entity_type       public.wms_sscc_entity NOT NULL,
  entity_id         uuid,
  warehouse_id      uuid,
  packaging_type_id uuid REFERENCES public.wms_packaging_types(id) ON DELETE SET NULL,
  status            public.wms_sscc_status NOT NULL DEFAULT 'assigned',
  void_reason       text,
  voided_at         timestamptz,
  voided_by         uuid,
  printed_count     integer NOT NULL DEFAULT 0,
  last_printed_at   timestamptz,
  payload           jsonb NOT NULL DEFAULT '{}'::jsonb,
  assigned_by       uuid,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT wms_sscc_registry_sscc_uniq   UNIQUE (sscc),
  CONSTRAINT wms_sscc_registry_serial_uniq UNIQUE (business_id, serial_reference),
  CONSTRAINT wms_sscc_registry_sscc_chk    CHECK (sscc ~ '^[0-9]{18}$')
);

CREATE INDEX IF NOT EXISTS idx_wms_sscc_registry_business ON public.wms_sscc_registry (business_id, status);
CREATE INDEX IF NOT EXISTS idx_wms_sscc_registry_entity   ON public.wms_sscc_registry (entity_type, entity_id);
-- One live SSCC per handling unit.
CREATE UNIQUE INDEX IF NOT EXISTS idx_wms_sscc_registry_active_entity
  ON public.wms_sscc_registry (entity_type, entity_id)
  WHERE status = 'assigned' AND entity_id IS NOT NULL;

GRANT SELECT ON public.wms_sscc_registry TO authenticated;
GRANT ALL    ON public.wms_sscc_registry TO service_role;
ALTER TABLE public.wms_sscc_registry ENABLE ROW LEVEL SECURITY;

CREATE POLICY "wms_sscc_registry_select" ON public.wms_sscc_registry FOR SELECT TO authenticated
  USING (public.user_can_access_business(auth.uid(), business_id));

-- ---------------------------------------------------------------------
-- 4) wms_gs1_config_upsert
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.wms_gs1_config_upsert(
  p_business_id uuid,
  p_payload jsonb,
  p_row_version integer DEFAULT NULL
) RETURNS public.wms_gs1_config
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_row public.wms_gs1_config;
  v_org uuid;
  v_p   jsonb := COALESCE(p_payload, '{}'::jsonb);
BEGIN
  PERFORM public._wms_packaging_assert_write(p_business_id);
  SELECT organization_id INTO v_org FROM public.businesses WHERE id = p_business_id;

  SELECT * INTO v_row FROM public.wms_gs1_config WHERE business_id = p_business_id FOR UPDATE;

  IF v_row.id IS NULL THEN
    INSERT INTO public.wms_gs1_config (
      organization_id, business_id, company_prefix, extension_digit,
      label_format, is_enabled, notes, created_by, updated_by
    ) VALUES (
      v_org, p_business_id,
      regexp_replace(COALESCE(v_p->>'company_prefix',''), '\s', '', 'g'),
      COALESCE((v_p->>'extension_digit')::smallint, 0::smallint),
      COALESCE(NULLIF(v_p->>'label_format',''), 'gs1_128'),
      COALESCE((v_p->>'is_enabled')::boolean, true),
      NULLIF(v_p->>'notes',''), auth.uid(), auth.uid()
    ) RETURNING * INTO v_row;
  ELSE
    IF p_row_version IS NOT NULL AND p_row_version <> v_row.row_version THEN
      RAISE EXCEPTION 'WMS_GS1_CONFLICT: row_version mismatch (expected %, got %)',
        v_row.row_version, p_row_version;
    END IF;
    UPDATE public.wms_gs1_config SET
      company_prefix  = COALESCE(regexp_replace(NULLIF(v_p->>'company_prefix',''), '\s', '', 'g'), company_prefix),
      extension_digit = COALESCE((v_p->>'extension_digit')::smallint, extension_digit),
      label_format    = COALESCE(NULLIF(v_p->>'label_format',''), label_format),
      is_enabled      = COALESCE((v_p->>'is_enabled')::boolean, is_enabled),
      notes           = CASE WHEN v_p ? 'notes' THEN NULLIF(v_p->>'notes','') ELSE notes END,
      row_version     = row_version + 1,
      updated_by      = auth.uid(),
      updated_at      = now()
    WHERE id = v_row.id
    RETURNING * INTO v_row;
  END IF;

  RETURN v_row;
END; $$;

REVOKE ALL ON FUNCTION public.wms_gs1_config_upsert(uuid, jsonb, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.wms_gs1_config_upsert(uuid, jsonb, integer) TO authenticated, service_role;

-- ---------------------------------------------------------------------
-- 5) wms_sscc_allocate — atomic, idempotent per handling unit
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.wms_sscc_allocate(
  p_business_id uuid,
  p_entity_type public.wms_sscc_entity,
  p_entity_id uuid DEFAULT NULL,
  p_count integer DEFAULT 1,
  p_options jsonb DEFAULT '{}'::jsonb
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_cfg    public.wms_gs1_config;
  v_opt    jsonb := COALESCE(p_options, '{}'::jsonb);
  v_count  integer := GREATEST(1, LEAST(COALESCE(p_count, 1), 500));
  v_serial bigint;
  v_sscc   text;
  v_rows   jsonb := '[]'::jsonb;
  v_row    public.wms_sscc_registry;
  v_i      integer;
BEGIN
  PERFORM public._wms_packaging_assert_write(p_business_id);

  -- Idempotency: a handling unit keeps its live SSCC.
  IF p_entity_id IS NOT NULL THEN
    SELECT * INTO v_row FROM public.wms_sscc_registry
     WHERE entity_type = p_entity_type AND entity_id = p_entity_id AND status = 'assigned'
     LIMIT 1;
    IF v_row.id IS NOT NULL THEN
      RETURN jsonb_build_object(
        'reused', true,
        'sscc_list', jsonb_build_array(jsonb_build_object(
          'id', v_row.id, 'sscc', v_row.sscc, 'serial_reference', v_row.serial_reference))
      );
    END IF;
    v_count := 1;
  END IF;

  SELECT * INTO v_cfg FROM public.wms_gs1_config
   WHERE business_id = p_business_id FOR UPDATE;

  IF v_cfg.id IS NULL THEN
    RAISE EXCEPTION 'WMS_GS1_NOT_CONFIGURED: set a GS1 company prefix before issuing SSCCs';
  END IF;
  IF NOT v_cfg.is_enabled THEN
    RAISE EXCEPTION 'WMS_GS1_DISABLED: GS1 labelling is disabled for this business';
  END IF;

  FOR v_i IN 1..v_count LOOP
    UPDATE public.wms_gs1_config
       SET sscc_next_serial = sscc_next_serial + 1, updated_at = now()
     WHERE id = v_cfg.id
     RETURNING sscc_next_serial - 1 INTO v_serial;

    v_sscc := public.wms_sscc_build(v_cfg.company_prefix, v_cfg.extension_digit, v_serial);

    INSERT INTO public.wms_sscc_registry (
      organization_id, business_id, sscc, serial_reference, entity_type, entity_id,
      warehouse_id, packaging_type_id, payload, assigned_by
    ) VALUES (
      v_cfg.organization_id, p_business_id, v_sscc, v_serial, p_entity_type, p_entity_id,
      NULLIF(v_opt->>'warehouse_id','')::uuid,
      NULLIF(v_opt->>'packaging_type_id','')::uuid,
      COALESCE(v_opt->'payload', '{}'::jsonb),
      auth.uid()
    ) RETURNING * INTO v_row;

    v_rows := v_rows || jsonb_build_array(jsonb_build_object(
      'id', v_row.id, 'sscc', v_row.sscc, 'serial_reference', v_row.serial_reference));
  END LOOP;

  BEGIN
    INSERT INTO public.business_event_outbox (
      event_type, organization_id, business_id,
      source_doc_type, source_doc_id, payload, idempotency_key, status
    ) VALUES (
      'wms.sscc.allocated', v_cfg.organization_id, p_business_id,
      'wms_sscc_registry', v_row.id,
      jsonb_build_object('entity_type', p_entity_type, 'entity_id', p_entity_id,
                         'count', v_count, 'sscc_list', v_rows),
      'wms.sscc.allocated:' || v_row.id,
      'pending'
    );
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'sscc event emission failed: %', SQLERRM;
  END;

  RETURN jsonb_build_object('reused', false, 'sscc_list', v_rows);
END; $$;

REVOKE ALL ON FUNCTION public.wms_sscc_allocate(uuid, public.wms_sscc_entity, uuid, integer, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.wms_sscc_allocate(uuid, public.wms_sscc_entity, uuid, integer, jsonb)
  TO authenticated, service_role;

-- ---------------------------------------------------------------------
-- 6) wms_sscc_void — retire a code (serial is never reused)
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.wms_sscc_void(
  p_business_id uuid, p_sscc text, p_reason text DEFAULT NULL
) RETURNS public.wms_sscc_registry
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_row public.wms_sscc_registry;
BEGIN
  PERFORM public._wms_packaging_assert_write(p_business_id);

  SELECT * INTO v_row FROM public.wms_sscc_registry
   WHERE business_id = p_business_id AND sscc = p_sscc FOR UPDATE;

  IF v_row.id IS NULL THEN
    RAISE EXCEPTION 'WMS_SSCC_NOT_FOUND: % is not registered for this business', p_sscc;
  END IF;
  IF v_row.status = 'voided' THEN
    RETURN v_row;
  END IF;

  UPDATE public.wms_sscc_registry
     SET status = 'voided', void_reason = NULLIF(p_reason,''),
         voided_at = now(), voided_by = auth.uid(), updated_at = now()
   WHERE id = v_row.id
   RETURNING * INTO v_row;

  RETURN v_row;
END; $$;

REVOKE ALL ON FUNCTION public.wms_sscc_void(uuid, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.wms_sscc_void(uuid, text, text) TO authenticated, service_role;

-- ---------------------------------------------------------------------
-- 7) wms_sscc_label_payload — GS1-128 element string + HRI, print audit
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.wms_sscc_label_payload(
  p_business_id uuid, p_sscc text, p_mark_printed boolean DEFAULT false
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_row public.wms_sscc_registry;
  v_pkg public.wms_packaging_types;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'WMS_GS1_AUTH: authentication required';
  END IF;
  IF NOT public.user_can_access_business(auth.uid(), p_business_id) THEN
    RAISE EXCEPTION 'WMS_GS1_FORBIDDEN: business access denied';
  END IF;

  SELECT * INTO v_row FROM public.wms_sscc_registry
   WHERE business_id = p_business_id AND sscc = p_sscc;
  IF v_row.id IS NULL THEN
    RAISE EXCEPTION 'WMS_SSCC_NOT_FOUND: % is not registered for this business', p_sscc;
  END IF;

  IF v_row.packaging_type_id IS NOT NULL THEN
    SELECT * INTO v_pkg FROM public.wms_packaging_types WHERE id = v_row.packaging_type_id;
  END IF;

  IF p_mark_printed THEN
    PERFORM public._wms_packaging_assert_write(p_business_id);
    UPDATE public.wms_sscc_registry
       SET printed_count = printed_count + 1, last_printed_at = now(), updated_at = now()
     WHERE id = v_row.id
     RETURNING * INTO v_row;
  END IF;

  RETURN jsonb_build_object(
    'sscc', v_row.sscc,
    'status', v_row.status,
    'valid', public.wms_sscc_is_valid(v_row.sscc),
    'entity_type', v_row.entity_type,
    'entity_id', v_row.entity_id,
    'element_string', '(00)' || v_row.sscc,
    'barcode_data', '00' || v_row.sscc,          -- GS1-128 / DataMatrix data, AI(00) is fixed-length
    'hri', 'SSCC (00) ' || v_row.sscc,
    'symbology', COALESCE((SELECT label_format FROM public.wms_gs1_config WHERE business_id = p_business_id), 'gs1_128'),
    'packaging', CASE WHEN v_pkg.id IS NULL THEN NULL ELSE jsonb_build_object(
      'id', v_pkg.id, 'code', v_pkg.code, 'name', v_pkg.name,
      'packaging_class', v_pkg.packaging_class,
      'outer_length_cm', v_pkg.outer_length_cm,
      'outer_width_cm', v_pkg.outer_width_cm,
      'outer_height_cm', v_pkg.outer_height_cm,
      'tare_weight_kg', v_pkg.tare_weight_kg) END,
    'printed_count', v_row.printed_count,
    'last_printed_at', v_row.last_printed_at
  );
END; $$;

REVOKE ALL ON FUNCTION public.wms_sscc_label_payload(uuid, text, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.wms_sscc_label_payload(uuid, text, boolean) TO authenticated, service_role;

-- ---------------------------------------------------------------------
-- 8) updated_at triggers
-- ---------------------------------------------------------------------
DROP TRIGGER IF EXISTS trg_wms_gs1_config_updated_at ON public.wms_gs1_config;
CREATE TRIGGER trg_wms_gs1_config_updated_at
  BEFORE UPDATE ON public.wms_gs1_config
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

DROP TRIGGER IF EXISTS trg_wms_sscc_registry_updated_at ON public.wms_sscc_registry;
CREATE TRIGGER trg_wms_sscc_registry_updated_at
  BEFORE UPDATE ON public.wms_sscc_registry
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();