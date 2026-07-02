
-- =====================================================================
-- LOCALIZATION PACK PLATFORM — Phase 1 foundation
-- =====================================================================

-- 1. Pack versions (lifecycle)
CREATE TABLE IF NOT EXISTS public.pack_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pack_id uuid NOT NULL REFERENCES public.localization_packs(id) ON DELETE CASCADE,
  version text NOT NULL,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','staged','published','archived')),
  changelog text,
  snapshot jsonb,
  published_at timestamptz,
  published_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  UNIQUE (pack_id, version)
);
CREATE INDEX IF NOT EXISTS pack_versions_pack_status_idx ON public.pack_versions(pack_id, status);
ALTER TABLE public.pack_versions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Platform admins manage pack_versions" ON public.pack_versions;
CREATE POLICY "Platform admins manage pack_versions" ON public.pack_versions
  FOR ALL TO authenticated
  USING (public.is_platform_admin(auth.uid()))
  WITH CHECK (public.is_platform_admin(auth.uid()));
DROP POLICY IF EXISTS "Anyone can read published pack_versions" ON public.pack_versions;
CREATE POLICY "Anyone can read published pack_versions" ON public.pack_versions
  FOR SELECT TO authenticated USING (status = 'published');

-- 2. Rule-type schemas
CREATE TABLE IF NOT EXISTS public.pack_rule_type_schemas (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  rule_type text NOT NULL,
  computation_kind text NOT NULL,
  schema_version int NOT NULL DEFAULT 1,
  json_schema jsonb NOT NULL,
  ui_schema jsonb,
  token_outputs jsonb NOT NULL DEFAULT '[]'::jsonb,
  description text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (rule_type, computation_kind, schema_version)
);
ALTER TABLE public.pack_rule_type_schemas ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Authenticated read pack_rule_type_schemas" ON public.pack_rule_type_schemas;
CREATE POLICY "Authenticated read pack_rule_type_schemas" ON public.pack_rule_type_schemas
  FOR SELECT TO authenticated USING (true);
DROP POLICY IF EXISTS "Platform admins manage pack_rule_type_schemas" ON public.pack_rule_type_schemas;
CREATE POLICY "Platform admins manage pack_rule_type_schemas" ON public.pack_rule_type_schemas
  FOR ALL TO authenticated
  USING (public.is_platform_admin(auth.uid()))
  WITH CHECK (public.is_platform_admin(auth.uid()));

-- 3. Token registry
CREATE TABLE IF NOT EXISTS public.pack_token_registry (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pack_id uuid REFERENCES public.localization_packs(id) ON DELETE CASCADE,
  token_path text NOT NULL,
  source text NOT NULL,
  data_type text NOT NULL,
  sample_value jsonb,
  description text,
  deprecated_in_version text,
  replaces text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (pack_id, token_path)
);
CREATE INDEX IF NOT EXISTS pack_token_registry_pack_idx ON public.pack_token_registry(pack_id);
ALTER TABLE public.pack_token_registry ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Authenticated read pack_token_registry" ON public.pack_token_registry;
CREATE POLICY "Authenticated read pack_token_registry" ON public.pack_token_registry
  FOR SELECT TO authenticated USING (true);
DROP POLICY IF EXISTS "Platform admins manage pack_token_registry" ON public.pack_token_registry;
CREATE POLICY "Platform admins manage pack_token_registry" ON public.pack_token_registry
  FOR ALL TO authenticated
  USING (public.is_platform_admin(auth.uid()))
  WITH CHECK (public.is_platform_admin(auth.uid()));

-- 4. Upgrade proposals
CREATE TABLE IF NOT EXISTS public.pack_upgrade_proposals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  business_id uuid,
  pack_id uuid NOT NULL REFERENCES public.localization_packs(id) ON DELETE CASCADE,
  from_version text NOT NULL,
  to_version text NOT NULL,
  diff jsonb NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','accepted','partially_accepted','rejected','superseded')),
  decided_by uuid,
  decided_at timestamptz,
  decision_notes text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS pack_upgrade_proposals_org_pack_idx ON public.pack_upgrade_proposals(organization_id, pack_id, status);
ALTER TABLE public.pack_upgrade_proposals ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Org members read upgrade proposals" ON public.pack_upgrade_proposals;
CREATE POLICY "Org members read upgrade proposals" ON public.pack_upgrade_proposals
  FOR SELECT TO authenticated USING (public.is_org_member(auth.uid(), organization_id));
DROP POLICY IF EXISTS "Org admins decide upgrade proposals" ON public.pack_upgrade_proposals;
CREATE POLICY "Org admins decide upgrade proposals" ON public.pack_upgrade_proposals
  FOR UPDATE TO authenticated
  USING (public.is_org_member(auth.uid(), organization_id))
  WITH CHECK (public.is_org_member(auth.uid(), organization_id));

-- 5. Audit log
CREATE TABLE IF NOT EXISTS public.pack_audit_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pack_id uuid REFERENCES public.localization_packs(id) ON DELETE SET NULL,
  organization_id uuid,
  actor_id uuid,
  scope text NOT NULL,
  entity_table text NOT NULL,
  entity_id uuid,
  action text NOT NULL,
  before jsonb,
  after jsonb,
  metadata jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS pack_audit_log_pack_idx ON public.pack_audit_log(pack_id, created_at DESC);
CREATE INDEX IF NOT EXISTS pack_audit_log_org_idx ON public.pack_audit_log(organization_id, created_at DESC);
ALTER TABLE public.pack_audit_log ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Pack audit read scoped" ON public.pack_audit_log;
CREATE POLICY "Pack audit read scoped" ON public.pack_audit_log
  FOR SELECT TO authenticated
  USING (public.is_platform_admin(auth.uid())
      OR (organization_id IS NOT NULL AND public.is_org_member(auth.uid(), organization_id)));
DROP POLICY IF EXISTS "Authenticated insert audit" ON public.pack_audit_log;
CREATE POLICY "Authenticated insert audit" ON public.pack_audit_log
  FOR INSERT TO authenticated WITH CHECK (true);

-- 6. Override link columns on payroll_statutory_rules
ALTER TABLE public.payroll_statutory_rules
  ADD COLUMN IF NOT EXISTS base_pack_template_id uuid REFERENCES public.localization_pack_payroll_templates(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS base_pack_version text,
  ADD COLUMN IF NOT EXISTS override_reason text,
  ADD COLUMN IF NOT EXISTS override_version int NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS is_tenant_override boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS legacy_unvalidated boolean NOT NULL DEFAULT true;
CREATE INDEX IF NOT EXISTS payroll_statutory_rules_base_template_idx
  ON public.payroll_statutory_rules(base_pack_template_id);

-- 7. JSON Schema validator (lightweight subset)
CREATE OR REPLACE FUNCTION public.validate_jsonb_against_schema(
  _payload jsonb,
  _schema jsonb,
  _path text DEFAULT '$'
) RETURNS text[]
LANGUAGE plpgsql IMMUTABLE
SET search_path = public
AS $fn$
DECLARE
  _errors text[] := '{}';
  _type text;
  _required text;
  _key text;
  _prop jsonb;
  _item jsonb;
  _i int;
  _val_text text;
  _val_num numeric;
BEGIN
  IF _schema IS NULL THEN RETURN _errors; END IF;
  _type := _schema->>'type';
  IF _payload IS NULL OR jsonb_typeof(_payload) = 'null' THEN
    IF _type IS NOT NULL AND _type <> 'null' AND COALESCE((_schema->>'nullable')::bool,false) = false THEN
      _errors := _errors || (_path || ': value is null but schema requires ' || _type);
    END IF;
    RETURN _errors;
  END IF;
  IF _type IS NOT NULL THEN
    IF _type = 'object' AND jsonb_typeof(_payload) <> 'object' THEN
      _errors := _errors || (_path || ': expected object, got ' || jsonb_typeof(_payload));
      RETURN _errors;
    ELSIF _type = 'array' AND jsonb_typeof(_payload) <> 'array' THEN
      _errors := _errors || (_path || ': expected array, got ' || jsonb_typeof(_payload));
      RETURN _errors;
    ELSIF _type IN ('number','integer') AND jsonb_typeof(_payload) <> 'number' THEN
      _errors := _errors || (_path || ': expected ' || _type || ', got ' || jsonb_typeof(_payload));
      RETURN _errors;
    ELSIF _type = 'string' AND jsonb_typeof(_payload) <> 'string' THEN
      _errors := _errors || (_path || ': expected string, got ' || jsonb_typeof(_payload));
      RETURN _errors;
    ELSIF _type = 'boolean' AND jsonb_typeof(_payload) <> 'boolean' THEN
      _errors := _errors || (_path || ': expected boolean, got ' || jsonb_typeof(_payload));
      RETURN _errors;
    END IF;
  END IF;
  IF _schema ? 'enum' THEN
    IF NOT (_schema->'enum') @> jsonb_build_array(_payload) THEN
      _errors := _errors || (_path || ': value not in enum ' || (_schema->'enum')::text);
    END IF;
  END IF;
  IF jsonb_typeof(_payload) = 'number' THEN
    _val_num := (_payload)::text::numeric;
    IF _schema ? 'minimum' AND _val_num < (_schema->>'minimum')::numeric THEN
      _errors := _errors || (_path || ': below minimum ' || (_schema->>'minimum'));
    END IF;
    IF _schema ? 'maximum' AND _val_num > (_schema->>'maximum')::numeric THEN
      _errors := _errors || (_path || ': above maximum ' || (_schema->>'maximum'));
    END IF;
  END IF;
  IF jsonb_typeof(_payload) = 'string' THEN
    _val_text := _payload #>> '{}';
    IF _schema ? 'minLength' AND length(_val_text) < (_schema->>'minLength')::int THEN
      _errors := _errors || (_path || ': string shorter than minLength');
    END IF;
    IF _schema ? 'maxLength' AND length(_val_text) > (_schema->>'maxLength')::int THEN
      _errors := _errors || (_path || ': string longer than maxLength');
    END IF;
  END IF;
  IF jsonb_typeof(_payload) = 'object' THEN
    IF _schema ? 'required' THEN
      FOR _required IN SELECT jsonb_array_elements_text(_schema->'required') LOOP
        IF NOT (_payload ? _required) THEN
          _errors := _errors || (_path || '.' || _required || ': required property missing');
        END IF;
      END LOOP;
    END IF;
    IF _schema ? 'properties' THEN
      FOR _key, _prop IN SELECT * FROM jsonb_each(_schema->'properties') LOOP
        IF _payload ? _key THEN
          _errors := _errors || public.validate_jsonb_against_schema(_payload->_key, _prop, _path || '.' || _key);
        END IF;
      END LOOP;
    END IF;
  END IF;
  IF jsonb_typeof(_payload) = 'array' AND _schema ? 'items' THEN
    _i := 0;
    FOR _item IN SELECT jsonb_array_elements(_payload) LOOP
      _errors := _errors || public.validate_jsonb_against_schema(_item, _schema->'items', _path || '[' || _i || ']');
      _i := _i + 1;
    END LOOP;
  END IF;
  RETURN _errors;
END;
$fn$;

-- 8. Resolve schema for a (rule_type, computation_kind)
CREATE OR REPLACE FUNCTION public.resolve_pack_rule_schema(
  _rule_type text,
  _computation_kind text
) RETURNS jsonb
LANGUAGE sql STABLE
SET search_path = public
AS $$
  SELECT json_schema FROM public.pack_rule_type_schemas
  WHERE rule_type = _rule_type AND computation_kind = _computation_kind
  ORDER BY schema_version DESC LIMIT 1;
$$;

-- 9. Validation trigger for payroll_statutory_rules + pack templates
CREATE OR REPLACE FUNCTION public.assert_pack_payload_valid()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $fn$
DECLARE
  _kind text;
  _schema jsonb;
  _errs text[];
BEGIN
  _kind := COALESCE(NEW.parameters->>'type', 'unknown');
  _schema := public.resolve_pack_rule_schema(NEW.rule_type, _kind);
  IF _schema IS NULL THEN
    BEGIN
      NEW.legacy_unvalidated := true;
    EXCEPTION WHEN undefined_column THEN NULL;
    END;
    RETURN NEW;
  END IF;
  _errs := public.validate_jsonb_against_schema(NEW.parameters, _schema);
  IF array_length(_errs,1) > 0 THEN
    BEGIN
      IF COALESCE(NEW.legacy_unvalidated, false) = false THEN
        RAISE EXCEPTION 'Invalid payroll rule parameters for % (%): %', NEW.rule_name, _kind, array_to_string(_errs, '; ');
      END IF;
    EXCEPTION WHEN undefined_column THEN
      RAISE EXCEPTION 'Invalid payroll rule parameters for % (%): %', NEW.rule_name, _kind, array_to_string(_errs, '; ');
    END;
  ELSE
    BEGIN
      NEW.legacy_unvalidated := false;
    EXCEPTION WHEN undefined_column THEN NULL;
    END;
  END IF;
  RETURN NEW;
END;
$fn$;

DROP TRIGGER IF EXISTS trg_assert_pack_payload_valid ON public.payroll_statutory_rules;
CREATE TRIGGER trg_assert_pack_payload_valid
  BEFORE INSERT OR UPDATE ON public.payroll_statutory_rules
  FOR EACH ROW EXECUTE FUNCTION public.assert_pack_payload_valid();

DROP TRIGGER IF EXISTS trg_assert_pack_template_payload_valid ON public.localization_pack_payroll_templates;
CREATE TRIGGER trg_assert_pack_template_payload_valid
  BEFORE INSERT OR UPDATE ON public.localization_pack_payroll_templates
  FOR EACH ROW EXECUTE FUNCTION public.assert_pack_payload_valid();

-- 10. Seed JSON Schemas
INSERT INTO public.pack_rule_type_schemas (rule_type, computation_kind, json_schema, ui_schema, token_outputs, description) VALUES
('income_tax','progressive',
 '{"type":"object","required":["type","brackets","currency","period"],"properties":{"type":{"type":"string","enum":["progressive"]},"currency":{"type":"string","minLength":3,"maxLength":3},"period":{"type":"string","enum":["monthly","annual","weekly"]},"personal_relief":{"type":"number","minimum":0},"insurance_relief_max":{"type":"number","minimum":0},"insurance_relief_rate":{"type":"number","minimum":0,"maximum":100},"disability_exemption":{"type":"number","minimum":0},"brackets":{"type":"array","items":{"type":"object","required":["min","rate"],"properties":{"min":{"type":"number","minimum":0},"max":{"type":"number","nullable":true},"rate":{"type":"number","minimum":0,"maximum":100}}}},"notes":{"type":"string"}}}'::jsonb,
 '{"brackets":{"ui:widget":"bracket-table"}}'::jsonb,
 '["run.income_tax","run.income_tax_relief","run.taxable_income"]'::jsonb,
 'Progressive income tax with brackets (PAYE-style)'),
('statutory_deduction','tiered',
 '{"type":"object","required":["type","tiers","currency","period"],"properties":{"type":{"type":"string","enum":["tiered"]},"currency":{"type":"string","minLength":3,"maxLength":3},"period":{"type":"string","enum":["monthly","annual","weekly"]},"tiers":{"type":"array","items":{"type":"object","required":["name","employee_rate","employer_rate","lower_earnings_limit"],"properties":{"name":{"type":"string","minLength":1},"lower_earnings_limit":{"type":"number","minimum":0},"upper_earnings_limit":{"type":"number","nullable":true},"employee_rate":{"type":"number","minimum":0,"maximum":100},"employer_rate":{"type":"number","minimum":0,"maximum":100}}}},"notes":{"type":"string"}}}'::jsonb,
 '{"tiers":{"ui:widget":"tier-table"}}'::jsonb,
 '["run.deduction_employee","run.deduction_employer"]'::jsonb,
 'Tiered employee+employer contribution (NSSF-style)'),
('statutory_deduction','percentage',
 '{"type":"object","required":["type","base","period"],"properties":{"type":{"type":"string","enum":["percentage"]},"base":{"type":"string","enum":["gross_pay","basic_pay","taxable_pay","net_pay"]},"currency":{"type":"string","minLength":3,"maxLength":3},"period":{"type":"string","enum":["monthly","annual","weekly"]},"rate":{"type":"number","minimum":0,"maximum":100},"employee_rate":{"type":"number","minimum":0,"maximum":100},"employer_rate":{"type":"number","minimum":0,"maximum":100},"employee_only":{"type":"boolean"},"min_amount":{"type":"number","minimum":0},"max_amount":{"type":"number","minimum":0},"notes":{"type":"string"}}}'::jsonb,
 NULL,
 '["run.deduction_employee","run.deduction_employer"]'::jsonb,
 'Percentage-of-base deduction (SHIF/AHL-style)'),
('statutory_deduction','graduated',
 '{"type":"object","required":["type","brackets","currency","period"],"properties":{"type":{"type":"string","enum":["graduated"]},"currency":{"type":"string","minLength":3,"maxLength":3},"period":{"type":"string","enum":["monthly","annual","weekly"]},"status":{"type":"string"},"brackets":{"type":"array","items":{"type":"object","required":["min","amount"],"properties":{"min":{"type":"number","minimum":0},"max":{"type":"number","nullable":true},"amount":{"type":"number","minimum":0}}}},"notes":{"type":"string"}}}'::jsonb,
 NULL,
 '["run.deduction_employee"]'::jsonb,
 'Graduated lookup table (legacy NHIF-style)'),
('employer_contribution','fixed',
 '{"type":"object","required":["type","amount_per_employee","currency","period"],"properties":{"type":{"type":"string","enum":["fixed"]},"amount_per_employee":{"type":"number","minimum":0},"currency":{"type":"string","minLength":3,"maxLength":3},"period":{"type":"string","enum":["monthly","annual","weekly"]},"employer_only":{"type":"boolean"},"notes":{"type":"string"}}}'::jsonb,
 NULL,
 '["run.employer_contribution"]'::jsonb,
 'Fixed per-employee employer contribution (NITA-style)')
ON CONFLICT (rule_type, computation_kind, schema_version) DO UPDATE
SET json_schema = EXCLUDED.json_schema,
    ui_schema   = EXCLUDED.ui_schema,
    token_outputs = EXCLUDED.token_outputs,
    description = EXCLUDED.description,
    updated_at  = now();

-- 11. Seed platform-wide tokens
INSERT INTO public.pack_token_registry (pack_id, token_path, source, data_type, sample_value, description) VALUES
  (NULL, 'employee.full_name',        'employee',   'string',   '"Jane Doe"'::jsonb,   'Employee full name'),
  (NULL, 'employee.employee_number',  'employee',   'string',   '"EMP-0001"'::jsonb,   'Internal employee number'),
  (NULL, 'employee.tax_id',           'employee',   'string',   '"A001234567X"'::jsonb,'Tax identification number'),
  (NULL, 'employee.national_id',      'employee',   'string',   '"12345678"'::jsonb,   'National ID'),
  (NULL, 'employee.bank_account',     'employee',   'string',   '"0000123456"'::jsonb, 'Primary bank account'),
  (NULL, 'contract.basic_salary',     'contract',   'currency', '50000'::jsonb,        'Contractual basic salary'),
  (NULL, 'contract.start_date',       'contract',   'date',     '"2024-01-01"'::jsonb, 'Contract start date'),
  (NULL, 'contract.job_title',        'contract',   'string',   '"Engineer"'::jsonb,   'Job title'),
  (NULL, 'run.period_start',          'run',        'date',     '"2026-05-01"'::jsonb, 'Payroll period start'),
  (NULL, 'run.period_end',            'run',        'date',     '"2026-05-31"'::jsonb, 'Payroll period end'),
  (NULL, 'run.gross_pay',             'run',        'currency', '50000'::jsonb,        'Gross pay total'),
  (NULL, 'run.net_pay',               'run',        'currency', '38500'::jsonb,        'Net pay after deductions'),
  (NULL, 'run.taxable_pay',           'run',        'currency', '47000'::jsonb,        'Taxable pay base'),
  (NULL, 'run.total_deductions',      'run',        'currency', '11500'::jsonb,        'Sum of all deductions'),
  (NULL, 'run.total_employer_cost',   'run',        'currency', '55000'::jsonb,        'Total employer cost'),
  (NULL, 'organization.name',         'system',     'string',   '"Acme Ltd"'::jsonb,   'Tenant organization name'),
  (NULL, 'organization.tax_id',       'system',     'string',   '"P051234567X"'::jsonb,'Organization tax id')
ON CONFLICT (pack_id, token_path) DO NOTHING;

-- 12. Backfill flags + version rows
UPDATE public.payroll_statutory_rules SET legacy_unvalidated = true WHERE legacy_unvalidated IS NULL;

INSERT INTO public.pack_versions (pack_id, version, status, published_at, created_at)
SELECT id, COALESCE(version,'1.0.0'),
       CASE WHEN is_published THEN 'published' ELSE 'draft' END,
       CASE WHEN is_published THEN created_at ELSE NULL END,
       created_at
FROM public.localization_packs
ON CONFLICT (pack_id, version) DO NOTHING;
