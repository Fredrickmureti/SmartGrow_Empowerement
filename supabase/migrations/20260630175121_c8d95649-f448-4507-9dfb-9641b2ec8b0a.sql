
CREATE TABLE IF NOT EXISTS public.localization_pack_garnishment_kinds (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pack_id uuid NOT NULL REFERENCES public.localization_packs(id) ON DELETE CASCADE,
  code text NOT NULL,
  label text NOT NULL,
  default_priority int NOT NULL DEFAULT 100,
  always_first boolean NOT NULL DEFAULT false,
  counts_toward_aggregate_cap boolean NOT NULL DEFAULT true,
  max_concurrent int,
  employer_fee_amount numeric(12,2) NOT NULL DEFAULT 0,
  employer_fee_account_role text,
  required_identifiers jsonb NOT NULL DEFAULT '[]'::jsonb,
  evidence_required boolean NOT NULL DEFAULT true,
  description text,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (pack_id, code)
);
GRANT SELECT ON public.localization_pack_garnishment_kinds TO authenticated, anon;
GRANT INSERT, UPDATE, DELETE ON public.localization_pack_garnishment_kinds TO authenticated;
GRANT ALL ON public.localization_pack_garnishment_kinds TO service_role;
ALTER TABLE public.localization_pack_garnishment_kinds ENABLE ROW LEVEL SECURITY;
CREATE POLICY "lpgk read all" ON public.localization_pack_garnishment_kinds FOR SELECT USING (true);
CREATE POLICY "lpgk write platform admin" ON public.localization_pack_garnishment_kinds FOR ALL
  USING (public.is_platform_admin(auth.uid())) WITH CHECK (public.is_platform_admin(auth.uid()));

CREATE TABLE IF NOT EXISTS public.localization_pack_garnishment_policies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pack_id uuid NOT NULL REFERENCES public.localization_packs(id) ON DELETE CASCADE,
  policy_key text NOT NULL DEFAULT 'default',
  aggregate_cap_pct numeric(6,4),
  min_take_home_amount numeric(14,2),
  min_take_home_pct numeric(6,4),
  disposable_income_excludes jsonb NOT NULL DEFAULT '[]'::jsonb,
  priority_resolution text NOT NULL DEFAULT 'always_first_then_priority_then_date',
  protected_earnings_formula_token text,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (pack_id, policy_key)
);
GRANT SELECT ON public.localization_pack_garnishment_policies TO authenticated, anon;
GRANT INSERT, UPDATE, DELETE ON public.localization_pack_garnishment_policies TO authenticated;
GRANT ALL ON public.localization_pack_garnishment_policies TO service_role;
ALTER TABLE public.localization_pack_garnishment_policies ENABLE ROW LEVEL SECURITY;
CREATE POLICY "lpgp read all" ON public.localization_pack_garnishment_policies FOR SELECT USING (true);
CREATE POLICY "lpgp write platform admin" ON public.localization_pack_garnishment_policies FOR ALL
  USING (public.is_platform_admin(auth.uid())) WITH CHECK (public.is_platform_admin(auth.uid()));

DROP TRIGGER IF EXISTS trg_lpgk_updated_at ON public.localization_pack_garnishment_kinds;
CREATE TRIGGER trg_lpgk_updated_at BEFORE UPDATE ON public.localization_pack_garnishment_kinds
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
DROP TRIGGER IF EXISTS trg_lpgp_updated_at ON public.localization_pack_garnishment_policies;
CREATE TRIGGER trg_lpgp_updated_at BEFORE UPDATE ON public.localization_pack_garnishment_policies
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

ALTER TABLE public.garnishment_kind_defaults
  ADD COLUMN IF NOT EXISTS organization_id uuid REFERENCES public.organizations(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS source_pack_id uuid REFERENCES public.localization_packs(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS max_concurrent int,
  ADD COLUMN IF NOT EXISTS employer_fee_amount numeric(12,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS required_identifiers jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS evidence_required boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS id uuid DEFAULT gen_random_uuid();
UPDATE public.garnishment_kind_defaults SET id = gen_random_uuid() WHERE id IS NULL;
DO $$
DECLARE v_pk text;
BEGIN
  SELECT conname INTO v_pk FROM pg_constraint
    WHERE conrelid='public.garnishment_kind_defaults'::regclass AND contype='p';
  IF v_pk IS NOT NULL THEN EXECUTE format('ALTER TABLE public.garnishment_kind_defaults DROP CONSTRAINT %I', v_pk); END IF;
END $$;
ALTER TABLE public.garnishment_kind_defaults ALTER COLUMN id SET NOT NULL, ADD PRIMARY KEY (id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_gkd_org_kind
  ON public.garnishment_kind_defaults (COALESCE(organization_id,'00000000-0000-0000-0000-000000000000'::uuid), kind);

CREATE OR REPLACE FUNCTION public.garnishment_resolve_kinds(p_org_id uuid)
RETURNS TABLE (kind text, label text, default_priority int, always_first boolean,
  counts_toward_aggregate_cap boolean, max_concurrent int, employer_fee_amount numeric,
  required_identifiers jsonb, evidence_required boolean, source text, source_pack_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  WITH pack_kinds AS (
    SELECT k.code AS kind, k.label, k.default_priority, k.always_first,
           k.counts_toward_aggregate_cap, k.max_concurrent, k.employer_fee_amount,
           k.required_identifiers, k.evidence_required, k.pack_id
    FROM localization_pack_garnishment_kinds k
    JOIN installed_localization_packs i ON i.pack_id = k.pack_id
    JOIN businesses b ON b.id = i.business_id
    WHERE b.organization_id = p_org_id AND i.status='active' AND k.is_active=true
  ),
  tenant_overrides AS (
    SELECT g.kind, NULL::text AS label, g.default_priority, g.always_first,
           g.counts_toward_aggregate_cap, g.max_concurrent, g.employer_fee_amount,
           g.required_identifiers, g.evidence_required, g.source_pack_id AS pack_id
    FROM garnishment_kind_defaults g WHERE g.organization_id = p_org_id
  ),
  platform_defaults AS (
    SELECT g.kind, NULL::text, g.default_priority, g.always_first,
           g.counts_toward_aggregate_cap, g.max_concurrent, g.employer_fee_amount,
           g.required_identifiers, g.evidence_required, NULL::uuid
    FROM garnishment_kind_defaults g WHERE g.organization_id IS NULL
  ),
  merged AS (
    SELECT *, 'tenant'::text AS source FROM tenant_overrides
    UNION ALL SELECT *, 'pack'::text FROM pack_kinds
    UNION ALL SELECT *, 'platform'::text FROM platform_defaults
  ),
  ranked AS (
    SELECT m.*, row_number() OVER (PARTITION BY m.kind
      ORDER BY CASE m.source WHEN 'tenant' THEN 0 WHEN 'pack' THEN 1 ELSE 2 END) AS rn FROM merged m
  )
  SELECT kind, COALESCE(label, kind), default_priority, always_first,
         counts_toward_aggregate_cap, max_concurrent, employer_fee_amount,
         required_identifiers, evidence_required, source, pack_id
  FROM ranked WHERE rn=1 ORDER BY always_first DESC, default_priority ASC, kind ASC;
$$;
GRANT EXECUTE ON FUNCTION public.garnishment_resolve_kinds(uuid) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.garnishment_resolve_policy(p_org_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE v_tenant record; v_pack record;
BEGIN
  SELECT garnishment_aggregate_cap_pct AS aggregate_cap_pct,
         garnishment_minimum_take_home_amount AS min_take_home_amount,
         garnishment_minimum_take_home_pct AS min_take_home_pct
    INTO v_tenant FROM payroll_settings WHERE organization_id = p_org_id LIMIT 1;
  SELECT p.aggregate_cap_pct, p.min_take_home_amount, p.min_take_home_pct,
         p.disposable_income_excludes, p.priority_resolution,
         p.protected_earnings_formula_token, p.pack_id
    INTO v_pack FROM localization_pack_garnishment_policies p
    JOIN installed_localization_packs i ON i.pack_id = p.pack_id
    JOIN businesses b ON b.id = i.business_id
    WHERE b.organization_id = p_org_id AND i.status='active' AND p.policy_key='default'
    ORDER BY i.installed_at DESC LIMIT 1;
  RETURN jsonb_build_object(
    'aggregate_cap_pct',     COALESCE(v_tenant.aggregate_cap_pct, v_pack.aggregate_cap_pct),
    'min_take_home_amount',  COALESCE(v_tenant.min_take_home_amount, v_pack.min_take_home_amount),
    'min_take_home_pct',     COALESCE(v_tenant.min_take_home_pct, v_pack.min_take_home_pct),
    'disposable_income_excludes', COALESCE(v_pack.disposable_income_excludes, '[]'::jsonb),
    'priority_resolution',   COALESCE(v_pack.priority_resolution, 'always_first_then_priority_then_date'),
    'protected_earnings_formula_token', v_pack.protected_earnings_formula_token,
    'source_pack_id', v_pack.pack_id,
    'tenant_overrides', jsonb_build_object(
      'aggregate_cap_pct',    v_tenant.aggregate_cap_pct,
      'min_take_home_amount', v_tenant.min_take_home_amount,
      'min_take_home_pct',    v_tenant.min_take_home_pct));
END $$;
GRANT EXECUTE ON FUNCTION public.garnishment_resolve_policy(uuid) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.garnishment_apply_pack_to_org(p_org_id uuid, p_pack_id uuid)
RETURNS int LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_n int := 0;
BEGIN
  WITH ins AS (
    INSERT INTO garnishment_kind_defaults
      (organization_id, source_pack_id, kind, default_priority, always_first,
       counts_toward_aggregate_cap, max_concurrent, employer_fee_amount,
       required_identifiers, evidence_required)
    SELECT p_org_id, p_pack_id, k.code, k.default_priority, k.always_first,
           k.counts_toward_aggregate_cap, k.max_concurrent, k.employer_fee_amount,
           k.required_identifiers, k.evidence_required
    FROM localization_pack_garnishment_kinds k
    WHERE k.pack_id=p_pack_id AND k.is_active=true
      AND NOT EXISTS (SELECT 1 FROM garnishment_kind_defaults g
                      WHERE g.organization_id=p_org_id AND g.kind=k.code)
    RETURNING 1)
  SELECT count(*) INTO v_n FROM ins; RETURN v_n;
END $$;
GRANT EXECUTE ON FUNCTION public.garnishment_apply_pack_to_org(uuid, uuid) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public._trg_installed_pack_propagate_garnishments()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NEW.status = 'active' THEN
    PERFORM public.garnishment_apply_pack_to_org(NEW.organization_id, NEW.pack_id);
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_installed_pack_garnishments ON public.installed_localization_packs;
CREATE TRIGGER trg_installed_pack_garnishments
  AFTER INSERT OR UPDATE OF status, pack_version ON public.installed_localization_packs
  FOR EACH ROW EXECUTE FUNCTION public._trg_installed_pack_propagate_garnishments();

INSERT INTO public.pack_rule_type_schemas (rule_type, computation_kind, schema_version, json_schema, ui_schema, token_outputs, description)
VALUES
  ('garnishment_kind', 'catalog', 1,
   jsonb_build_object('type','object','required', jsonb_build_array('code','label'),
     'properties', jsonb_build_object(
       'code', jsonb_build_object('type','string'),
       'label', jsonb_build_object('type','string'),
       'default_priority', jsonb_build_object('type','integer','default',100),
       'always_first', jsonb_build_object('type','boolean','default',false),
       'counts_toward_aggregate_cap', jsonb_build_object('type','boolean','default',true),
       'max_concurrent', jsonb_build_object('type','integer'),
       'employer_fee_amount', jsonb_build_object('type','number','default',0),
       'employer_fee_account_role', jsonb_build_object('type','string'),
       'required_identifiers', jsonb_build_object('type','array','items', jsonb_build_object('type','string')),
       'evidence_required', jsonb_build_object('type','boolean','default',true),
       'description', jsonb_build_object('type','string'))),
   NULL,
   jsonb_build_array('garnishment.<code>.amount','garnishment.<code>.fee'),
   'Country garnishment kind catalog row'),
  ('garnishment_policy', 'policy', 1,
   jsonb_build_object('type','object',
     'properties', jsonb_build_object(
       'aggregate_cap_pct', jsonb_build_object('type','number','minimum',0,'maximum',1),
       'min_take_home_amount', jsonb_build_object('type','number'),
       'min_take_home_pct', jsonb_build_object('type','number','minimum',0,'maximum',1),
       'disposable_income_excludes', jsonb_build_object('type','array','items', jsonb_build_object('type','string')),
       'priority_resolution', jsonb_build_object('type','string','enum',
         jsonb_build_array('order_date_asc','priority_then_date','always_first_then_priority_then_date')),
       'protected_earnings_formula_token', jsonb_build_object('type','string'),
       'notes', jsonb_build_object('type','string'))),
   NULL,
   jsonb_build_array('garnishment.aggregate_cap_pct','garnishment.protected_earnings'),
   'Country garnishment policy')
ON CONFLICT DO NOTHING;

INSERT INTO public.pack_token_registry (pack_id, token_path, source, data_type, sample_value, description)
VALUES
  (NULL, 'garnishment.aggregate_cap_pct',   'rule_output', 'number',   '0.25'::jsonb,    'Resolved aggregate cap for the org'),
  (NULL, 'garnishment.protected_earnings',  'rule_output', 'currency', '1500.00'::jsonb, 'Per-employee protected-earnings floor'),
  (NULL, 'garnishment.kind.amount',         'rule_output', 'currency', '250.00'::jsonb,  'Per-order amount applied this period'),
  (NULL, 'garnishment.kind.fee',            'rule_output', 'currency', '1.00'::jsonb,    'Statutory employer admin fee')
ON CONFLICT DO NOTHING;

INSERT INTO public.payroll_readiness_rules
  (code, name, description, scope, severity, source, reason_code, check_kind, is_active)
VALUES (
  'GARNISHMENT_KIND_UNRESOLVED',
  'Garnishment kind not in installed pack',
  'An active garnishment order uses a kind not provided by any installed localization pack or platform default. Install/update the country pack or add a tenant override.',
  'org', 'block', 'core', 'garnishment_kind_unresolved', 'garnishment_kind_unresolved', true
) ON CONFLICT (organization_id, code) DO NOTHING;

COMMENT ON TABLE public.localization_pack_garnishment_kinds IS
  'Publisher-authored garnishment kind catalog. Consumed by garnishment_resolve_kinds and propagated on pack install.';
COMMENT ON TABLE public.localization_pack_garnishment_policies IS
  'Publisher-authored country garnishment policy. Consumed by garnishment_resolve_policy and the engine.';
COMMENT ON FUNCTION public.garnishment_resolve_kinds(uuid) IS
  'Merged garnishment kind catalog: tenant override > installed pack > platform default. Engine and UI MUST use this.';
COMMENT ON FUNCTION public.garnishment_resolve_policy(uuid) IS
  'Merged garnishment policy JSON. Engine MUST use this in place of reading payroll_settings or pack tables directly.';
