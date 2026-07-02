
DO $$ BEGIN
  CREATE TYPE public.bulk_operation_kind AS ENUM (
    'import_employees','export_employees',
    'bulk_department_transfer','bulk_manager_reassignment',
    'bulk_salary_revision','bulk_contract_creation','bulk_location_transfer'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE public.bulk_operation_status AS ENUM (
    'draft','validating','preview_ready','applying','completed','failed','cancelled'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE public.bulk_operation_runs (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  business_id UUID REFERENCES public.businesses(id) ON DELETE SET NULL,
  kind public.bulk_operation_kind NOT NULL,
  status public.bulk_operation_status NOT NULL DEFAULT 'draft',
  actor_user_id UUID,
  source_filename TEXT,
  source_storage_path TEXT,
  schema_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
  params JSONB NOT NULL DEFAULT '{}'::jsonb,
  rows_total INTEGER NOT NULL DEFAULT 0,
  rows_valid INTEGER NOT NULL DEFAULT 0,
  rows_invalid INTEGER NOT NULL DEFAULT 0,
  rows_applied INTEGER NOT NULL DEFAULT 0,
  rows_failed INTEGER NOT NULL DEFAULT 0,
  summary JSONB NOT NULL DEFAULT '{}'::jsonb,
  error_message TEXT,
  submitted_at TIMESTAMPTZ,
  applied_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_bulk_op_runs_org ON public.bulk_operation_runs(organization_id, created_at DESC);
CREATE INDEX idx_bulk_op_runs_kind ON public.bulk_operation_runs(kind, status);

GRANT SELECT ON public.bulk_operation_runs TO authenticated;
GRANT ALL ON public.bulk_operation_runs TO service_role;

ALTER TABLE public.bulk_operation_runs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "bulk_op_runs_read_authenticated"
  ON public.bulk_operation_runs FOR SELECT
  TO authenticated USING (true);

CREATE POLICY "bulk_op_runs_service_role_all"
  ON public.bulk_operation_runs FOR ALL
  TO service_role USING (true) WITH CHECK (true);

CREATE TABLE public.bulk_operation_row_results (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  run_id UUID NOT NULL REFERENCES public.bulk_operation_runs(id) ON DELETE CASCADE,
  row_index INTEGER NOT NULL,
  raw_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  normalized_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  validation_errors JSONB NOT NULL DEFAULT '[]'::jsonb,
  apply_status TEXT NOT NULL DEFAULT 'pending' CHECK (apply_status IN ('pending','skipped','applied','failed')),
  apply_error TEXT,
  target_table TEXT,
  target_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (run_id, row_index)
);

CREATE INDEX idx_bulk_op_row_run ON public.bulk_operation_row_results(run_id, row_index);
CREATE INDEX idx_bulk_op_row_status ON public.bulk_operation_row_results(run_id, apply_status);

GRANT SELECT ON public.bulk_operation_row_results TO authenticated;
GRANT ALL ON public.bulk_operation_row_results TO service_role;

ALTER TABLE public.bulk_operation_row_results ENABLE ROW LEVEL SECURITY;

CREATE POLICY "bulk_op_rows_read_authenticated"
  ON public.bulk_operation_row_results FOR SELECT
  TO authenticated USING (true);

CREATE POLICY "bulk_op_rows_service_role_all"
  ON public.bulk_operation_row_results FOR ALL
  TO service_role USING (true) WITH CHECK (true);

CREATE TRIGGER update_bulk_operation_runs_updated_at
  BEFORE UPDATE ON public.bulk_operation_runs
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
