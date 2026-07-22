
-- Phase 2 — Pack contract extension + tenant override table + install helper.

-- 1. Enums for the legal-behaviour contract.
DO $$ BEGIN
  CREATE TYPE public.legal_order_calc_model AS ENUM (
    'fixed','percent_disposable','percent_gross','balance_remaining','statutory_formula'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE public.legal_order_cap_membership AS ENUM (
    'in_pool','exempt','always_first'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE public.legal_order_completion_rule AS ENUM (
    'by_balance','by_date','by_court_order','indefinite'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- 2. Extend the pack contract with legal-behaviour columns (nullable — packs
--    that haven't been re-published yet keep working).
ALTER TABLE public.localization_pack_garnishment_kinds
  ADD COLUMN IF NOT EXISTS calc_model              public.legal_order_calc_model,
  ADD COLUMN IF NOT EXISTS priority_class          smallint,
  ADD COLUMN IF NOT EXISTS protected_earnings_rule jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS aggregate_cap_membership public.legal_order_cap_membership,
  ADD COLUMN IF NOT EXISTS remittance_schedule_ref  text,
  ADD COLUMN IF NOT EXISTS evidence_requirements    jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS completion_rule          public.legal_order_completion_rule,
  ADD COLUMN IF NOT EXISTS reporting_binding_ref    text;

-- Backfill derived defaults from the legacy boolean columns so existing packs
-- have coherent legal behaviour on first read.
UPDATE public.localization_pack_garnishment_kinds
   SET aggregate_cap_membership = CASE
         WHEN always_first THEN 'always_first'::public.legal_order_cap_membership
         WHEN NOT counts_toward_aggregate_cap THEN 'exempt'::public.legal_order_cap_membership
         ELSE 'in_pool'::public.legal_order_cap_membership
       END
 WHERE aggregate_cap_membership IS NULL;

UPDATE public.localization_pack_garnishment_kinds
   SET completion_rule = 'by_balance'::public.legal_order_completion_rule
 WHERE completion_rule IS NULL;

UPDATE public.localization_pack_garnishment_kinds
   SET calc_model = 'fixed'::public.legal_order_calc_model
 WHERE calc_model IS NULL;

-- 3. Symmetrically extend garnishment_kind_defaults (the tenant-facing
--    projection used by the engine + UI).
ALTER TABLE public.garnishment_kind_defaults
  ADD COLUMN IF NOT EXISTS calc_model              public.legal_order_calc_model,
  ADD COLUMN IF NOT EXISTS priority_class          smallint,
  ADD COLUMN IF NOT EXISTS protected_earnings_rule jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS aggregate_cap_membership public.legal_order_cap_membership,
  ADD COLUMN IF NOT EXISTS remittance_schedule_ref  text,
  ADD COLUMN IF NOT EXISTS evidence_requirements    jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS completion_rule          public.legal_order_completion_rule,
  ADD COLUMN IF NOT EXISTS reporting_binding_ref    text;

UPDATE public.garnishment_kind_defaults
   SET aggregate_cap_membership = CASE
         WHEN always_first THEN 'always_first'::public.legal_order_cap_membership
         WHEN NOT counts_toward_aggregate_cap THEN 'exempt'::public.legal_order_cap_membership
         ELSE 'in_pool'::public.legal_order_cap_membership
       END,
       completion_rule = COALESCE(completion_rule, 'by_balance'::public.legal_order_completion_rule),
       calc_model      = COALESCE(calc_model, 'fixed'::public.legal_order_calc_model)
 WHERE aggregate_cap_membership IS NULL
    OR completion_rule IS NULL
    OR calc_model IS NULL;

-- 4. Tenant override table — pack upgrades never fight tenant deviations.
CREATE TABLE IF NOT EXISTS public.legal_order_kind_overrides (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  kind text NOT NULL,
  override_json jsonb NOT NULL,
  reason text NOT NULL,
  approved_by uuid,
  approved_at timestamptz,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, kind)
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.legal_order_kind_overrides TO authenticated;
GRANT ALL ON public.legal_order_kind_overrides TO service_role;

ALTER TABLE public.legal_order_kind_overrides ENABLE ROW LEVEL SECURITY;

CREATE POLICY legal_order_kind_overrides_read
  ON public.legal_order_kind_overrides
  FOR SELECT TO authenticated
  USING (
    organization_id IN (
      SELECT uba.organization_id FROM public.user_business_access uba WHERE uba.user_id = auth.uid()
    )
  );

CREATE POLICY legal_order_kind_overrides_write
  ON public.legal_order_kind_overrides
  FOR ALL TO authenticated
  USING (
    organization_id IN (
      SELECT uba.organization_id FROM public.user_business_access uba WHERE uba.user_id = auth.uid()
    )
    AND (public.has_role(auth.uid(),'admin') OR public.has_role(auth.uid(),'owner'))
  )
  WITH CHECK (
    organization_id IN (
      SELECT uba.organization_id FROM public.user_business_access uba WHERE uba.user_id = auth.uid()
    )
    AND (public.has_role(auth.uid(),'admin') OR public.has_role(auth.uid(),'owner'))
  );

CREATE TRIGGER trg_legal_order_kind_overrides_updated_at
  BEFORE UPDATE ON public.legal_order_kind_overrides
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- 5. Install helper — copies published pack rows into the tenant's defaults.
--    Called by the install-localization-pack edge function after seeding
--    accounts + statutory rules. Idempotent (ON CONFLICT DO UPDATE).
CREATE OR REPLACE FUNCTION public.install_legal_order_kind_defaults(
  p_organization_id uuid,
  p_pack_id uuid
) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_count integer;
BEGIN
  IF p_organization_id IS NULL OR p_pack_id IS NULL THEN
    RAISE EXCEPTION 'install_legal_order_kind_defaults: organization_id and pack_id are required'
      USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.garnishment_kind_defaults (
    kind, default_priority, always_first, counts_toward_aggregate_cap,
    description, organization_id, source_pack_id, max_concurrent,
    employer_fee_amount, required_identifiers, evidence_required,
    calc_model, priority_class, protected_earnings_rule,
    aggregate_cap_membership, remittance_schedule_ref, evidence_requirements,
    completion_rule, reporting_binding_ref
  )
  SELECT
    k.code, k.default_priority, k.always_first, k.counts_toward_aggregate_cap,
    k.description, p_organization_id, p_pack_id, k.max_concurrent,
    k.employer_fee_amount, k.required_identifiers, k.evidence_required,
    COALESCE(k.calc_model, 'fixed'::public.legal_order_calc_model),
    k.priority_class,
    COALESCE(k.protected_earnings_rule, '{}'::jsonb),
    COALESCE(k.aggregate_cap_membership, CASE
      WHEN k.always_first THEN 'always_first'::public.legal_order_cap_membership
      WHEN NOT k.counts_toward_aggregate_cap THEN 'exempt'::public.legal_order_cap_membership
      ELSE 'in_pool'::public.legal_order_cap_membership
    END),
    k.remittance_schedule_ref,
    COALESCE(k.evidence_requirements, '{}'::jsonb),
    COALESCE(k.completion_rule, 'by_balance'::public.legal_order_completion_rule),
    k.reporting_binding_ref
  FROM public.localization_pack_garnishment_kinds k
  WHERE k.pack_id = p_pack_id
    AND k.is_active
  ON CONFLICT (organization_id, kind) DO UPDATE
    SET default_priority             = EXCLUDED.default_priority,
        always_first                 = EXCLUDED.always_first,
        counts_toward_aggregate_cap  = EXCLUDED.counts_toward_aggregate_cap,
        description                  = EXCLUDED.description,
        source_pack_id               = EXCLUDED.source_pack_id,
        max_concurrent               = EXCLUDED.max_concurrent,
        employer_fee_amount          = EXCLUDED.employer_fee_amount,
        required_identifiers         = EXCLUDED.required_identifiers,
        evidence_required            = EXCLUDED.evidence_required,
        calc_model                   = EXCLUDED.calc_model,
        priority_class               = EXCLUDED.priority_class,
        protected_earnings_rule      = EXCLUDED.protected_earnings_rule,
        aggregate_cap_membership     = EXCLUDED.aggregate_cap_membership,
        remittance_schedule_ref      = EXCLUDED.remittance_schedule_ref,
        evidence_requirements        = EXCLUDED.evidence_requirements,
        completion_rule              = EXCLUDED.completion_rule,
        reporting_binding_ref        = EXCLUDED.reporting_binding_ref;

  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END $$;

REVOKE ALL ON FUNCTION public.install_legal_order_kind_defaults(uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.install_legal_order_kind_defaults(uuid,uuid) TO service_role;

COMMENT ON FUNCTION public.install_legal_order_kind_defaults IS
  'Phase 2: copies published pack legal-order kind rows into a tenant''s garnishment_kind_defaults. Called by install-localization-pack. Idempotent.';

-- Make sure the org/kind pair is unique so ON CONFLICT works.
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
     WHERE schemaname='public' AND indexname='garnishment_kind_defaults_org_kind_uk'
  ) THEN
    CREATE UNIQUE INDEX garnishment_kind_defaults_org_kind_uk
      ON public.garnishment_kind_defaults (organization_id, kind)
      WHERE organization_id IS NOT NULL;
  END IF;
END $$;
