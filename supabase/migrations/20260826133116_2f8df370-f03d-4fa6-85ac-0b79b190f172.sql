
CREATE TABLE IF NOT EXISTS public.__ts_wave5_results (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ran_at timestamptz NOT NULL DEFAULT now(),
  result jsonb NOT NULL
);
ALTER TABLE public.__ts_wave5_results ENABLE ROW LEVEL SECURITY;
GRANT ALL ON public.__ts_wave5_results TO service_role;

CREATE OR REPLACE FUNCTION public.__ts_wave5_record(_r jsonb)
RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = public AS
$$ INSERT INTO public.__ts_wave5_results(result) VALUES (_r); $$;
REVOKE ALL ON FUNCTION public.__ts_wave5_record(jsonb) FROM PUBLIC, anon, authenticated;
