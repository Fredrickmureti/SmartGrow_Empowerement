ALTER TABLE public.mf_loans ALTER COLUMN application_id DROP NOT NULL;
ALTER TABLE public.mf_loans ADD CONSTRAINT mf_loans_application_or_lineage_chk
  CHECK (application_id IS NOT NULL OR parent_loan_id IS NOT NULL);