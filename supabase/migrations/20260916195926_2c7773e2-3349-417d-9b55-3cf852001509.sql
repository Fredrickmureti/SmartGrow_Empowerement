ALTER TABLE public.mf_loan_product_versions
  ADD COLUMN IF NOT EXISTS interest_recognition text NOT NULL DEFAULT 'on_repayment';

ALTER TABLE public.mf_loan_product_versions
  ADD CONSTRAINT mf_lpv_interest_recognition_chk
  CHECK (interest_recognition IN ('on_repayment','on_schedule_date'));

ALTER TABLE public.mf_loans
  ADD COLUMN IF NOT EXISTS interest_recognition text NOT NULL DEFAULT 'on_repayment';

ALTER TABLE public.mf_loans
  ADD CONSTRAINT mf_loans_interest_recognition_chk
  CHECK (interest_recognition IN ('on_repayment','on_schedule_date'));

COMMENT ON COLUMN public.mf_loan_product_versions.interest_recognition IS
  'When interest withheld at payout is moved from the unearned-interest holding account into income: on_repayment (after the instalment is received) or on_schedule_date (when the instalment falls due). Only meaningful when interest_collection = deducted_upfront.';
COMMENT ON COLUMN public.mf_loans.interest_recognition IS
  'Frozen copy of the product version setting at loan creation.';