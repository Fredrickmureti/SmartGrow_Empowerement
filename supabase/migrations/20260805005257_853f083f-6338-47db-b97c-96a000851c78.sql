CREATE TABLE public.print_traces (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  correlation_id text NOT NULL,
  label text NOT NULL,
  total_ms integer NOT NULL DEFAULT 0,
  spans jsonb NOT NULL DEFAULT '[]'::jsonb,
  attributes jsonb NOT NULL DEFAULT '{}'::jsonb,
  organization_id uuid,
  business_id uuid,
  created_by uuid NOT NULL DEFAULT auth.uid(),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX print_traces_correlation_idx ON public.print_traces (correlation_id);
CREATE INDEX print_traces_created_at_idx ON public.print_traces (created_at DESC);
CREATE INDEX print_traces_label_idx ON public.print_traces (label, created_at DESC);

GRANT SELECT, INSERT ON public.print_traces TO authenticated;
GRANT ALL ON public.print_traces TO service_role;

ALTER TABLE public.print_traces ENABLE ROW LEVEL SECURITY;

CREATE POLICY "print_traces_insert_own" ON public.print_traces
  FOR INSERT TO authenticated
  WITH CHECK (created_by = auth.uid());

CREATE POLICY "print_traces_select_own" ON public.print_traces
  FOR SELECT TO authenticated
  USING (created_by = auth.uid());