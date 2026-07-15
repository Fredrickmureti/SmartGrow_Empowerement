-- Payroll Reporting Centre — Phase 1+2 (schema)
--
-- Extends `payroll_report_definitions` with the ownership / preview /
-- export / metadata contract described by the enterprise reporting
-- centre plan, and introduces `payroll_report_runs` as the canonical
-- history record for every report generation.

-- 1. Enrichment columns -------------------------------------------------
ALTER TABLE public.payroll_report_definitions
  ADD COLUMN IF NOT EXISTS owner_kind text NOT NULL DEFAULT 'payroll_engine',
  ADD COLUMN IF NOT EXISTS owner_ref text,
  ADD COLUMN IF NOT EXISTS preview_kind text NOT NULL DEFAULT 'table',
  ADD COLUMN IF NOT EXISTS export_formats jsonb NOT NULL DEFAULT
    '[{"format":"pdf","label":"PDF","isPrimary":true},{"format":"csv","label":"CSV"},{"format":"xlsx","label":"Excel"}]'::jsonb,
  ADD COLUMN IF NOT EXISTS parameters jsonb NOT NULL DEFAULT
    '{"period":true,"branch":true}'::jsonb,
  ADD COLUMN IF NOT EXISTS metadata jsonb NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE public.payroll_report_definitions
  DROP CONSTRAINT IF EXISTS payroll_report_definitions_owner_kind_chk;
ALTER TABLE public.payroll_report_definitions
  ADD CONSTRAINT payroll_report_definitions_owner_kind_chk
  CHECK (owner_kind IN ('payroll_engine','finance','audit','localization_pack','management','hr'));

ALTER TABLE public.payroll_report_definitions
  DROP CONSTRAINT IF EXISTS payroll_report_definitions_preview_kind_chk;
ALTER TABLE public.payroll_report_definitions
  ADD CONSTRAINT payroll_report_definitions_preview_kind_chk
  CHECK (preview_kind IN ('table','summary','matrix','dashboard','statutory_form','certificate'));

-- 2. Backfill ownership + preview kinds for core rows -------------------
UPDATE public.payroll_report_definitions SET
  owner_kind = CASE
    WHEN category = 'audit'                                             THEN 'audit'
    WHEN category = 'management'                                        THEN 'management'
    WHEN report_key IN ('branch_payroll_cost','department_payroll_cost',
                        'payroll_gl_posting')                           THEN 'finance'
    WHEN category = 'compliance' AND country_code IS NOT NULL           THEN 'localization_pack'
    ELSE 'payroll_engine'
  END,
  preview_kind = CASE
    WHEN report_key = 'payroll_summary'                                 THEN 'summary'
    WHEN report_key IN ('payroll_variance','payroll_overtime')          THEN 'dashboard'
    WHEN report_key = 'payroll_gl_posting'                              THEN 'matrix'
    ELSE 'table'
  END
WHERE owner_kind = 'payroll_engine';

-- 3. History table ------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.payroll_report_runs (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id           uuid NOT NULL,
  business_id               uuid,
  report_key                text NOT NULL,
  report_label              text,
  owner_kind                text,
  params                    jsonb NOT NULL DEFAULT '{}'::jsonb,
  filters                   jsonb NOT NULL DEFAULT '{}'::jsonb,
  row_count                 integer,
  employee_count            integer,
  duration_ms               integer,
  status                    text NOT NULL DEFAULT 'succeeded'
    CHECK (status IN ('succeeded','failed','cancelled')),
  error                     text,
  pack_code                 text,
  pack_version              text,
  template_version          text,
  source_payroll_run_ids    uuid[] NOT NULL DEFAULT ARRAY[]::uuid[],
  generated_by              uuid,
  generated_at              timestamptz NOT NULL DEFAULT now(),
  created_at                timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS payroll_report_runs_org_idx
  ON public.payroll_report_runs (organization_id, generated_at DESC);
CREATE INDEX IF NOT EXISTS payroll_report_runs_report_idx
  ON public.payroll_report_runs (organization_id, report_key, generated_at DESC);

GRANT SELECT, INSERT ON public.payroll_report_runs TO authenticated;
GRANT ALL ON public.payroll_report_runs TO service_role;

ALTER TABLE public.payroll_report_runs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "payroll_report_runs_org_select" ON public.payroll_report_runs;
CREATE POLICY "payroll_report_runs_org_select"
  ON public.payroll_report_runs FOR SELECT TO authenticated
  USING (
    organization_id IN (
      SELECT organization_id FROM public.user_business_access
      WHERE user_id = auth.uid()
    )
  );

DROP POLICY IF EXISTS "payroll_report_runs_org_insert" ON public.payroll_report_runs;
CREATE POLICY "payroll_report_runs_org_insert"
  ON public.payroll_report_runs FOR INSERT TO authenticated
  WITH CHECK (
    organization_id IN (
      SELECT organization_id FROM public.user_business_access
      WHERE user_id = auth.uid()
    )
  );

COMMENT ON TABLE public.payroll_report_runs IS
  'Payroll Reporting Centre — one row per report generation. Feeds the History tab, audit trail and re-export flows.';
