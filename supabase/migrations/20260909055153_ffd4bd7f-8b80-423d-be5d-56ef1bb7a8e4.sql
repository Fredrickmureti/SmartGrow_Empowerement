ALTER TABLE public.mf_loan_product_versions
  ADD CONSTRAINT mf_lpv_grace_lt_term_chk
  CHECK (grace_period_installments < min_term_installments);

ALTER TABLE public.mf_loan_product_versions
  ADD CONSTRAINT mf_lpv_flat_basis_chk
  CHECK (interest_rate_period <> 'flat_on_principal' OR interest_method = 'flat');

CREATE UNIQUE INDEX IF NOT EXISTS mf_lpv_effective_from_uniq
  ON public.mf_loan_product_versions (product_id, effective_from);