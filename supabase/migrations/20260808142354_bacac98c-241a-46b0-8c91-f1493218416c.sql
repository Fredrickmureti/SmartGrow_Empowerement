CREATE TABLE IF NOT EXISTS public.recurring_invoice_test_results (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_at timestamptz NOT NULL DEFAULT now(),
  suite text NOT NULL,
  test_name text NOT NULL,
  passed boolean NOT NULL,
  detail text,
  created_at timestamptz NOT NULL DEFAULT now()
);

GRANT ALL ON public.recurring_invoice_test_results TO service_role;

ALTER TABLE public.recurring_invoice_test_results ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "service role manages recurring test results"
  ON public.recurring_invoice_test_results;
CREATE POLICY "service role manages recurring test results"
  ON public.recurring_invoice_test_results FOR ALL
  TO service_role USING (true) WITH CHECK (true);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'supabase_read_only_user') THEN
    EXECUTE 'GRANT SELECT ON public.recurring_invoice_test_results TO supabase_read_only_user';
  END IF;
END $$;

INSERT INTO public.recurring_invoice_test_results (suite, test_name, passed, detail)
SELECT 'calendar', t.test_name, t.passed, t.detail FROM public.test_recurring_calendar() t;

INSERT INTO public.recurring_invoice_test_results (suite, test_name, passed, detail)
SELECT 'engine', t.test_name, t.passed, t.detail FROM public.test_recurring_invoicing_engine() t;