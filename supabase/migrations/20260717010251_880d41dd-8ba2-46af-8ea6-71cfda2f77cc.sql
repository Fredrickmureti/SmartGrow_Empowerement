-- ADR 0075 — Durable log of quant-vs-warehouse-stock drift checks.
CREATE TABLE public.stock_quant_drift_runs (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  organization_id UUID NOT NULL,
  run_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  status TEXT NOT NULL DEFAULT 'completed' CHECK (status IN ('running','completed','failed')),
  products_checked INTEGER NOT NULL DEFAULT 0,
  drifted_rows INTEGER NOT NULL DEFAULT 0,
  total_drift_qty NUMERIC NOT NULL DEFAULT 0,
  sample_drift JSONB NOT NULL DEFAULT '[]'::jsonb,
  error_message TEXT,
  duration_ms INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_stock_quant_drift_runs_org_run_at
  ON public.stock_quant_drift_runs (organization_id, run_at DESC);

GRANT SELECT ON public.stock_quant_drift_runs TO authenticated;
GRANT ALL ON public.stock_quant_drift_runs TO service_role;

ALTER TABLE public.stock_quant_drift_runs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Org members can view their drift runs"
  ON public.stock_quant_drift_runs
  FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.user_business_access uba
      WHERE uba.user_id = auth.uid()
        AND uba.organization_id = stock_quant_drift_runs.organization_id
    )
  );

CREATE POLICY "Service role manages drift runs"
  ON public.stock_quant_drift_runs
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

CREATE TRIGGER trg_stock_quant_drift_runs_updated_at
  BEFORE UPDATE ON public.stock_quant_drift_runs
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- Helper used by the nightly job / edge function to record a completed run.
CREATE OR REPLACE FUNCTION public.record_stock_quant_drift_run(
  p_organization_id UUID,
  p_products_checked INTEGER,
  p_drifted_rows INTEGER,
  p_total_drift_qty NUMERIC,
  p_sample_drift JSONB,
  p_duration_ms INTEGER,
  p_status TEXT DEFAULT 'completed',
  p_error_message TEXT DEFAULT NULL
) RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_id UUID;
BEGIN
  INSERT INTO public.stock_quant_drift_runs (
    organization_id, status, products_checked, drifted_rows,
    total_drift_qty, sample_drift, duration_ms, error_message
  ) VALUES (
    p_organization_id, COALESCE(p_status, 'completed'), COALESCE(p_products_checked, 0),
    COALESCE(p_drifted_rows, 0), COALESCE(p_total_drift_qty, 0),
    COALESCE(p_sample_drift, '[]'::jsonb), p_duration_ms, p_error_message
  ) RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;

REVOKE ALL ON FUNCTION public.record_stock_quant_drift_run(UUID,INTEGER,INTEGER,NUMERIC,JSONB,INTEGER,TEXT,TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.record_stock_quant_drift_run(UUID,INTEGER,INTEGER,NUMERIC,JSONB,INTEGER,TEXT,TEXT) TO service_role;