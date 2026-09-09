ALTER TABLE public.mf_loans
  ADD CONSTRAINT mf_loans_rate_period_chk
  CHECK (interest_rate_period IS NULL OR interest_rate_period = ANY (ARRAY['per_annum','per_month','per_installment','flat_on_principal']));