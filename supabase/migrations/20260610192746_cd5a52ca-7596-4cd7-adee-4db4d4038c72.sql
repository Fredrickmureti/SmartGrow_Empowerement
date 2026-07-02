-- =====================================================================
-- HR / Payroll / Localization re-architecture — Step 1 (retry)
-- =====================================================================

-- 1. Enums
DO $$ BEGIN
  CREATE TYPE public.pack_requirement_scope AS ENUM (
    'employee_field', 'statutory_identifier', 'payroll_rule', 'account_mapping', 'onboarding_item'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE public.pack_requirement_module AS ENUM (
    'core', 'payroll', 'attendance', 'timesheets', 'benefits', 'hr'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE public.pack_requirement_source AS ENUM ('pack', 'tenant_override');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- 2. Table
CREATE TABLE IF NOT EXISTS public.pack_requirements (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  organization_id uuid NOT NULL,
  business_id uuid NOT NULL,
  pack_id uuid NULL,
  pack_version text NULL,
  scope public.pack_requirement_scope NOT NULL,
  module public.pack_requirement_module NOT NULL DEFAULT 'payroll',
  requirement_key text NOT NULL,
  country_code text NULL,
  label text NOT NULL,
  help_text text NULL,
  validation_regex text NULL,
  data_type text NOT NULL DEFAULT 'text',
  is_required boolean NOT NULL DEFAULT true,
  blocks_onboarding boolean NOT NULL DEFAULT false,
  blocks_payroll boolean NOT NULL DEFAULT true,
  applies_to_employment_types text[] NULL,
  sort_order integer NOT NULL DEFAULT 0,
  is_active boolean NOT NULL DEFAULT true,
  source public.pack_requirement_source NOT NULL DEFAULT 'pack',
  overrides_id uuid NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Unique per business across (scope, requirement_key, country_code, source).
CREATE UNIQUE INDEX IF NOT EXISTS pack_requirements_unique_key
  ON public.pack_requirements (business_id, scope, requirement_key, COALESCE(country_code, ''), source);

CREATE INDEX IF NOT EXISTS pack_requirements_business_module_idx
  ON public.pack_requirements (business_id, module, is_active);
CREATE INDEX IF NOT EXISTS pack_requirements_org_idx
  ON public.pack_requirements (organization_id);
CREATE INDEX IF NOT EXISTS pack_requirements_pack_idx
  ON public.pack_requirements (pack_id);

-- 3. Grants
GRANT SELECT, INSERT, UPDATE, DELETE ON public.pack_requirements TO authenticated;
GRANT ALL ON public.pack_requirements TO service_role;

-- 4. RLS
ALTER TABLE public.pack_requirements ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Members of the business can read pack_requirements" ON public.pack_requirements;
CREATE POLICY "Members of the business can read pack_requirements"
  ON public.pack_requirements FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.user_business_access uba
      WHERE uba.user_id = auth.uid()
        AND uba.business_id = pack_requirements.business_id
    )
  );

DROP POLICY IF EXISTS "Members can write tenant overrides" ON public.pack_requirements;
CREATE POLICY "Members can write tenant overrides"
  ON public.pack_requirements FOR INSERT TO authenticated
  WITH CHECK (
    source = 'tenant_override'
    AND EXISTS (
      SELECT 1 FROM public.user_business_access uba
      WHERE uba.user_id = auth.uid()
        AND uba.business_id = pack_requirements.business_id
    )
  );

DROP POLICY IF EXISTS "Members can update tenant overrides" ON public.pack_requirements;
CREATE POLICY "Members can update tenant overrides"
  ON public.pack_requirements FOR UPDATE TO authenticated
  USING (
    source = 'tenant_override'
    AND EXISTS (
      SELECT 1 FROM public.user_business_access uba
      WHERE uba.user_id = auth.uid()
        AND uba.business_id = pack_requirements.business_id
    )
  )
  WITH CHECK (source = 'tenant_override');

DROP POLICY IF EXISTS "Members can delete tenant overrides" ON public.pack_requirements;
CREATE POLICY "Members can delete tenant overrides"
  ON public.pack_requirements FOR DELETE TO authenticated
  USING (
    source = 'tenant_override'
    AND EXISTS (
      SELECT 1 FROM public.user_business_access uba
      WHERE uba.user_id = auth.uid()
        AND uba.business_id = pack_requirements.business_id
    )
  );

-- 5. updated_at trigger
CREATE OR REPLACE FUNCTION public.tg_pack_requirements_touch()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS pack_requirements_touch ON public.pack_requirements;
CREATE TRIGGER pack_requirements_touch
  BEFORE UPDATE ON public.pack_requirements
  FOR EACH ROW EXECUTE FUNCTION public.tg_pack_requirements_touch();

-- =====================================================================
-- 6. Country statutory seed catalog
-- =====================================================================
CREATE TABLE IF NOT EXISTS public.country_statutory_catalog (
  country_code text NOT NULL,
  requirement_key text NOT NULL,
  label text NOT NULL,
  help_text text NULL,
  validation_regex text NULL,
  data_type text NOT NULL DEFAULT 'text',
  is_required boolean NOT NULL DEFAULT true,
  blocks_onboarding boolean NOT NULL DEFAULT false,
  blocks_payroll boolean NOT NULL DEFAULT true,
  sort_order integer NOT NULL DEFAULT 0,
  PRIMARY KEY (country_code, requirement_key)
);

GRANT SELECT ON public.country_statutory_catalog TO authenticated, anon;
GRANT ALL ON public.country_statutory_catalog TO service_role;
ALTER TABLE public.country_statutory_catalog ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Anyone can read country statutory catalog" ON public.country_statutory_catalog;
CREATE POLICY "Anyone can read country statutory catalog"
  ON public.country_statutory_catalog FOR SELECT
  USING (true);

INSERT INTO public.country_statutory_catalog
  (country_code, requirement_key, label, help_text, validation_regex, sort_order, blocks_payroll, blocks_onboarding)
VALUES
  ('KE', 'tax_pin',       'KRA PIN',                'Kenya Revenue Authority Personal Identification Number', '^[AP]\d{9}[A-Z]$', 1, true, true),
  ('KE', 'nssf_number',   'NSSF Number',            'National Social Security Fund membership number',         NULL, 2, true, false),
  ('KE', 'shif_number',   'SHIF Number',            'Social Health Insurance Fund number',                     NULL, 3, true, false),
  ('KE', 'housing_levy',  'Housing Levy Reference', NULL,                                                      NULL, 4, false, false),
  ('UG', 'tin',           'URA TIN',                'Uganda Revenue Authority Tax Identification Number',      NULL, 1, true, true),
  ('UG', 'nssf_number',   'NSSF Number',            NULL,                                                      NULL, 2, true, false),
  ('TZ', 'tin',           'TRA TIN',                'Tanzania Revenue Authority TIN',                          NULL, 1, true, true),
  ('TZ', 'nssf_number',   'NSSF Number',            NULL,                                                      NULL, 2, true, false),
  ('RW', 'tin',           'RRA TIN',                'Rwanda Revenue Authority TIN',                            NULL, 1, true, true),
  ('RW', 'rssb_number',   'RSSB Number',            'Rwanda Social Security Board number',                     NULL, 2, true, false),
  ('NG', 'tin',           'FIRS TIN',               'Federal Inland Revenue Service TIN',                      NULL, 1, true, true),
  ('NG', 'pension_pin',   'Pension PIN',            NULL,                                                      NULL, 2, true, false),
  ('NG', 'nhis_number',   'NHIS Number',            NULL,                                                      NULL, 3, false, false),
  ('ZA', 'tax_number',    'SARS Tax Reference',     NULL,                                                      NULL, 1, true, true),
  ('ZA', 'uif_number',    'UIF Number',             NULL,                                                      NULL, 2, true, false),
  ('GB', 'nino',          'National Insurance Number', NULL, '^[A-CEGHJ-PR-TW-Z]{2}\d{6}[A-D]$', 1, true, true),
  ('GB', 'utr',           'UTR',                    'Unique Taxpayer Reference',                               NULL, 2, false, false),
  ('US', 'ssn',           'Social Security Number', NULL, '^\d{3}-?\d{2}-?\d{4}$', 1, true, true),
  ('US', 'ein',           'EIN',                    'Employer Identification Number',                          NULL, 2, false, false)
ON CONFLICT (country_code, requirement_key) DO UPDATE SET
  label = EXCLUDED.label,
  help_text = EXCLUDED.help_text,
  validation_regex = EXCLUDED.validation_regex,
  sort_order = EXCLUDED.sort_order;

-- =====================================================================
-- 7. Materializer
-- =====================================================================
CREATE OR REPLACE FUNCTION public.materialize_pack_requirements(
  p_business_id uuid,
  p_pack_id uuid
) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_org uuid;
  v_country text;
  v_version text;
  v_count integer := 0;
BEGIN
  SELECT lp.country_code, ilp.pack_version, ilp.organization_id
    INTO v_country, v_version, v_org
  FROM public.installed_localization_packs ilp
  JOIN public.localization_packs lp ON lp.id = ilp.pack_id
  WHERE ilp.pack_id = p_pack_id
    AND ilp.business_id = p_business_id
  LIMIT 1;

  IF v_country IS NULL THEN
    RETURN 0;
  END IF;

  INSERT INTO public.pack_requirements (
    organization_id, business_id, pack_id, pack_version,
    scope, module, requirement_key, country_code,
    label, help_text, validation_regex, data_type,
    is_required, blocks_onboarding, blocks_payroll,
    sort_order, source
  )
  SELECT
    v_org, p_business_id, p_pack_id, v_version,
    'statutory_identifier'::pack_requirement_scope,
    'payroll'::pack_requirement_module,
    c.requirement_key, c.country_code,
    c.label, c.help_text, c.validation_regex, c.data_type,
    c.is_required, c.blocks_onboarding, c.blocks_payroll,
    c.sort_order, 'pack'::pack_requirement_source
  FROM public.country_statutory_catalog c
  WHERE c.country_code = v_country
  ON CONFLICT (business_id, scope, requirement_key, COALESCE(country_code, ''), source)
  DO UPDATE SET
    pack_id = EXCLUDED.pack_id,
    pack_version = EXCLUDED.pack_version,
    label = EXCLUDED.label,
    help_text = EXCLUDED.help_text,
    validation_regex = EXCLUDED.validation_regex,
    sort_order = EXCLUDED.sort_order,
    is_active = true,
    updated_at = now();

  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END $$;

REVOKE ALL ON FUNCTION public.materialize_pack_requirements(uuid, uuid) FROM public;
GRANT EXECUTE ON FUNCTION public.materialize_pack_requirements(uuid, uuid) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.tg_installed_pack_materialize()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NEW.business_id IS NOT NULL THEN
    PERFORM public.materialize_pack_requirements(NEW.business_id, NEW.pack_id);
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS installed_pack_materialize ON public.installed_localization_packs;
CREATE TRIGGER installed_pack_materialize
  AFTER INSERT OR UPDATE OF pack_version, status ON public.installed_localization_packs
  FOR EACH ROW EXECUTE FUNCTION public.tg_installed_pack_materialize();

-- =====================================================================
-- 8. Backfill
-- =====================================================================
DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT business_id, pack_id
    FROM public.installed_localization_packs
    WHERE business_id IS NOT NULL
  LOOP
    PERFORM public.materialize_pack_requirements(r.business_id, r.pack_id);
  END LOOP;
END $$;

INSERT INTO public.pack_requirements (
  organization_id, business_id, pack_id,
  scope, module, requirement_key, country_code,
  label, help_text, validation_regex,
  is_required, blocks_onboarding, blocks_payroll,
  sort_order, source
)
SELECT
  h.organization_id, h.business_id, NULL,
  'statutory_identifier'::pack_requirement_scope,
  'payroll'::pack_requirement_module,
  h.identifier_type, h.country_code,
  COALESCE(h.label, h.identifier_type),
  h.help_text, h.validation_regex,
  h.is_required, h.blocks_onboarding, h.blocks_payroll,
  h.sort_order, 'tenant_override'::pack_requirement_source
FROM public.hr_statutory_field_config h
WHERE h.is_active = true
ON CONFLICT (business_id, scope, requirement_key, COALESCE(country_code, ''), source) DO NOTHING;

UPDATE public.employee_field_configs
SET is_visible = false, updated_at = now()
WHERE field_category = 'statutory'
  AND is_system = true
  AND field_key IN ('tax_pin', 'nssf_number', 'shif_number', 'nhif_number');

-- =====================================================================
-- 9. RPCs consumed by the UI
-- =====================================================================
CREATE OR REPLACE FUNCTION public.pack_required_employee_fields(
  p_business_id uuid,
  p_module text DEFAULT NULL
) RETURNS TABLE (
  requirement_key text,
  scope text,
  module text,
  country_code text,
  label text,
  help_text text,
  validation_regex text,
  data_type text,
  is_required boolean,
  blocks_onboarding boolean,
  blocks_payroll boolean,
  sort_order integer,
  pack_id uuid,
  source text,
  has_override boolean
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  WITH base AS (
    SELECT *
    FROM public.pack_requirements
    WHERE business_id = p_business_id
      AND is_active = true
      AND (p_module IS NULL OR module::text = p_module)
  ),
  ranked AS (
    SELECT
      requirement_key, scope::text AS scope, module::text AS module, country_code,
      label, help_text, validation_regex, data_type,
      is_required, blocks_onboarding, blocks_payroll, sort_order,
      pack_id, source::text AS source,
      ROW_NUMBER() OVER (
        PARTITION BY scope, requirement_key, COALESCE(country_code, '')
        ORDER BY CASE source WHEN 'tenant_override' THEN 0 ELSE 1 END
      ) AS rn,
      bool_or(source = 'tenant_override') OVER (
        PARTITION BY scope, requirement_key, COALESCE(country_code, '')
      ) AS has_override
    FROM base
  )
  SELECT
    requirement_key, scope, module, country_code, label, help_text,
    validation_regex, data_type, is_required, blocks_onboarding,
    blocks_payroll, sort_order, pack_id, source, has_override
  FROM ranked
  WHERE rn = 1
  ORDER BY scope, sort_order, label;
$$;

GRANT EXECUTE ON FUNCTION public.pack_required_employee_fields(uuid, text) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.employee_payroll_readiness(
  p_employee_id uuid
) RETURNS TABLE (
  employee_id uuid,
  has_contract boolean,
  has_salary boolean,
  has_schedule boolean,
  has_bank boolean,
  required_identifier_keys text[],
  present_identifier_keys text[],
  missing_identifier_keys text[],
  is_ready boolean,
  blockers text[]
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_business_id uuid;
  v_today date := CURRENT_DATE;
  v_contract record;
  v_salary numeric := 0;
  v_required text[] := ARRAY[]::text[];
  v_present text[] := ARRAY[]::text[];
  v_missing text[] := ARRAY[]::text[];
  v_blockers text[] := ARRAY[]::text[];
  v_has_contract boolean := false;
  v_has_salary boolean := false;
  v_has_schedule boolean := false;
  v_has_bank boolean := false;
BEGIN
  SELECT e.business_id INTO v_business_id
  FROM public.employees e WHERE e.id = p_employee_id;
  IF v_business_id IS NULL THEN RETURN; END IF;

  SELECT id, wage, working_schedule INTO v_contract
  FROM public.employee_contracts
  WHERE employee_id = p_employee_id
    AND status = 'running'
    AND start_date <= v_today
    AND (end_date IS NULL OR end_date >= v_today)
  ORDER BY start_date DESC
  LIMIT 1;

  v_has_contract := v_contract.id IS NOT NULL;
  v_has_schedule := v_contract.working_schedule IS NOT NULL;

  IF v_has_contract THEN
    SELECT COALESCE(v_contract.wage, 0) +
           COALESCE((SELECT SUM(amount) FROM public.contract_compensation_components
                     WHERE contract_id = v_contract.id), 0)
      INTO v_salary;
    v_has_salary := v_salary > 0;
  END IF;

  SELECT (e.bank_account_number IS NOT NULL AND e.bank_account_number <> '')
      OR (e.bank_name IS NOT NULL AND e.bank_name <> '')
    INTO v_has_bank
  FROM public.employees e WHERE e.id = p_employee_id;

  SELECT COALESCE(array_agg(DISTINCT pref.requirement_key), ARRAY[]::text[])
    INTO v_required
  FROM public.pack_required_employee_fields(v_business_id, 'payroll') pref
  WHERE pref.scope = 'statutory_identifier'
    AND pref.is_required = true
    AND pref.blocks_payroll = true;

  SELECT COALESCE(array_agg(DISTINCT esi.identifier_type), ARRAY[]::text[])
    INTO v_present
  FROM public.employee_statutory_identifiers esi
  WHERE esi.employee_id = p_employee_id
    AND esi.is_active = true
    AND COALESCE(esi.identifier_value, '') <> '';

  SELECT COALESCE(array_agg(k), ARRAY[]::text[]) INTO v_missing
  FROM unnest(v_required) AS k
  WHERE k <> ALL(v_present);

  IF NOT v_has_contract THEN v_blockers := v_blockers || 'Active contract missing'; END IF;
  IF v_has_contract AND NOT v_has_salary THEN v_blockers := v_blockers || 'Salary not set on contract'; END IF;
  IF v_has_contract AND NOT v_has_schedule THEN v_blockers := v_blockers || 'Working schedule missing'; END IF;
  IF array_length(v_missing, 1) > 0 THEN
    v_blockers := v_blockers || ('Missing statutory identifier(s): ' || array_to_string(v_missing, ', '));
  END IF;

  RETURN QUERY SELECT
    p_employee_id,
    v_has_contract, v_has_salary, v_has_schedule, v_has_bank,
    v_required, v_present, v_missing,
    (v_has_contract AND v_has_salary AND v_has_schedule
     AND COALESCE(array_length(v_missing,1),0) = 0),
    v_blockers;
END $$;

GRANT EXECUTE ON FUNCTION public.employee_payroll_readiness(uuid) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.business_payroll_readiness(p_business_id uuid)
RETURNS TABLE (
  employee_id uuid,
  first_name text,
  last_name text,
  employee_number text,
  has_contract boolean,
  has_salary boolean,
  has_schedule boolean,
  has_bank boolean,
  required_identifier_keys text[],
  missing_identifier_keys text[],
  is_ready boolean,
  blockers text[]
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT e.id, e.first_name, e.last_name, e.employee_number,
         r.has_contract, r.has_salary, r.has_schedule, r.has_bank,
         r.required_identifier_keys, r.missing_identifier_keys,
         r.is_ready, r.blockers
  FROM public.employees e
  LEFT JOIN LATERAL public.employee_payroll_readiness(e.id) r ON true
  WHERE e.business_id = p_business_id
    AND e.is_active = true
  ORDER BY e.last_name, e.first_name;
$$;

GRANT EXECUTE ON FUNCTION public.business_payroll_readiness(uuid) TO authenticated, service_role;