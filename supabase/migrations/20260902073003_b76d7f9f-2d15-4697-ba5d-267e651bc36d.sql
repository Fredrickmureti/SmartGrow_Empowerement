ALTER TABLE public.mf_loans
  ADD COLUMN IF NOT EXISTS parent_loan_id uuid REFERENCES public.mf_loans(id),
  ADD COLUMN IF NOT EXISTS lineage_kind text NOT NULL DEFAULT 'new',
  ADD COLUMN IF NOT EXISTS settled_by_loan_id uuid REFERENCES public.mf_loans(id);

ALTER TABLE public.mf_loans
  DROP CONSTRAINT IF EXISTS mf_loans_lineage_kind_chk;

ALTER TABLE public.mf_loans
  ADD CONSTRAINT mf_loans_lineage_kind_chk
  CHECK (lineage_kind IN ('new','topup','restructure'));

ALTER TABLE public.mf_loans
  DROP CONSTRAINT IF EXISTS mf_loans_lineage_parent_chk;

ALTER TABLE public.mf_loans
  ADD CONSTRAINT mf_loans_lineage_parent_chk
  CHECK ((lineage_kind = 'new') = (parent_loan_id IS NULL));

CREATE UNIQUE INDEX IF NOT EXISTS mf_loans_parent_loan_uniq
  ON public.mf_loans(parent_loan_id) WHERE parent_loan_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS mf_loans_settled_by_idx
  ON public.mf_loans(settled_by_loan_id) WHERE settled_by_loan_id IS NOT NULL;