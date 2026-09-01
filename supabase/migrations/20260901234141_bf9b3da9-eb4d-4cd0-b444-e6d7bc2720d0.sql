CREATE TABLE public.mf_event_postings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL,
  loan_event_id uuid NOT NULL UNIQUE REFERENCES public.mf_loan_events(id) ON DELETE RESTRICT,
  journal_entry_id uuid NOT NULL REFERENCES public.journal_entries(id) ON DELETE RESTRICT,
  posting_kind text NOT NULL DEFAULT 'original',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX mf_event_postings_je_idx ON public.mf_event_postings(journal_entry_id);
GRANT SELECT ON public.mf_event_postings TO authenticated;
GRANT ALL ON public.mf_event_postings TO service_role;
ALTER TABLE public.mf_event_postings ENABLE ROW LEVEL SECURITY;
CREATE POLICY "mf_event_postings_read_institution" ON public.mf_event_postings
  FOR SELECT TO authenticated
  USING (public.user_has_business_access(auth.uid(), business_id));