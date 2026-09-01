CREATE TABLE public.mf_loan_products (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
  code text NOT NULL,
  name text NOT NULL,
  description text,
  status text NOT NULL DEFAULT 'draft',
  current_version_id uuid,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT mf_loan_products_status_chk CHECK (status IN ('draft','active','retired')),
  CONSTRAINT mf_loan_products_code_uniq UNIQUE (business_id, code)
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.mf_loan_products TO authenticated;
GRANT ALL ON public.mf_loan_products TO service_role;

ALTER TABLE public.mf_loan_products ENABLE ROW LEVEL SECURITY;

CREATE POLICY mf_loan_products_read ON public.mf_loan_products
  FOR SELECT TO authenticated
  USING (user_has_business_access(auth.uid(), business_id));

CREATE POLICY mf_loan_products_insert ON public.mf_loan_products
  FOR INSERT TO authenticated
  WITH CHECK (user_has_business_access(auth.uid(), business_id)
    AND (has_role(auth.uid(), 'super_admin') OR has_role(auth.uid(), 'admin') OR has_role(auth.uid(), 'branch_manager')));

CREATE POLICY mf_loan_products_update ON public.mf_loan_products
  FOR UPDATE TO authenticated
  USING (user_has_business_access(auth.uid(), business_id)
    AND (has_role(auth.uid(), 'super_admin') OR has_role(auth.uid(), 'admin') OR has_role(auth.uid(), 'branch_manager')))
  WITH CHECK (user_has_business_access(auth.uid(), business_id));

CREATE POLICY mf_loan_products_delete ON public.mf_loan_products
  FOR DELETE TO authenticated
  USING (user_has_business_access(auth.uid(), business_id)
    AND (has_role(auth.uid(), 'super_admin') OR has_role(auth.uid(), 'admin'))
    AND current_version_id IS NULL);

CREATE TABLE public.mf_loan_product_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
  product_id uuid NOT NULL REFERENCES public.mf_loan_products(id) ON DELETE CASCADE,
  version_no integer NOT NULL,
  currency_code text NOT NULL DEFAULT 'KES',
  min_amount numeric(18,2) NOT NULL,
  max_amount numeric(18,2) NOT NULL,
  min_term_installments integer NOT NULL,
  max_term_installments integer NOT NULL,
  repayment_frequency text NOT NULL,
  interest_method text NOT NULL,
  interest_rate numeric(9,4) NOT NULL,
  interest_rate_period text NOT NULL DEFAULT 'per_annum',
  grace_period_installments integer NOT NULL DEFAULT 0,
  fees jsonb NOT NULL DEFAULT '[]'::jsonb,
  penalty_rate numeric(9,4) NOT NULL DEFAULT 0,
  penalty_basis text NOT NULL DEFAULT 'overdue_installment',
  eligibility jsonb NOT NULL DEFAULT '{}'::jsonb,
  effective_from date NOT NULL DEFAULT CURRENT_DATE,
  is_published boolean NOT NULL DEFAULT false,
  published_at timestamptz,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT mf_lpv_version_uniq UNIQUE (product_id, version_no),
  CONSTRAINT mf_lpv_amount_chk CHECK (min_amount > 0 AND max_amount >= min_amount),
  CONSTRAINT mf_lpv_term_chk CHECK (min_term_installments > 0 AND max_term_installments >= min_term_installments),
  CONSTRAINT mf_lpv_frequency_chk CHECK (repayment_frequency IN ('daily','weekly','biweekly','monthly')),
  CONSTRAINT mf_lpv_method_chk CHECK (interest_method IN ('flat','declining_balance','declining_balance_equal_installments')),
  CONSTRAINT mf_lpv_rate_period_chk CHECK (interest_rate_period IN ('per_annum','per_month','per_installment','flat_on_principal')),
  CONSTRAINT mf_lpv_penalty_basis_chk CHECK (penalty_basis IN ('overdue_installment','overdue_principal','outstanding_balance')),
  CONSTRAINT mf_lpv_rate_chk CHECK (interest_rate >= 0 AND penalty_rate >= 0),
  CONSTRAINT mf_lpv_grace_chk CHECK (grace_period_installments >= 0)
);

CREATE INDEX mf_lpv_product_idx ON public.mf_loan_product_versions (product_id, version_no DESC);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.mf_loan_product_versions TO authenticated;
GRANT ALL ON public.mf_loan_product_versions TO service_role;

ALTER TABLE public.mf_loan_product_versions ENABLE ROW LEVEL SECURITY;

CREATE POLICY mf_lpv_read ON public.mf_loan_product_versions
  FOR SELECT TO authenticated
  USING (user_has_business_access(auth.uid(), business_id));

CREATE POLICY mf_lpv_insert ON public.mf_loan_product_versions
  FOR INSERT TO authenticated
  WITH CHECK (user_has_business_access(auth.uid(), business_id)
    AND (has_role(auth.uid(), 'super_admin') OR has_role(auth.uid(), 'admin') OR has_role(auth.uid(), 'branch_manager')));

CREATE POLICY mf_lpv_update ON public.mf_loan_product_versions
  FOR UPDATE TO authenticated
  USING (user_has_business_access(auth.uid(), business_id)
    AND (has_role(auth.uid(), 'super_admin') OR has_role(auth.uid(), 'admin') OR has_role(auth.uid(), 'branch_manager')))
  WITH CHECK (user_has_business_access(auth.uid(), business_id));

CREATE POLICY mf_lpv_delete ON public.mf_loan_product_versions
  FOR DELETE TO authenticated
  USING (user_has_business_access(auth.uid(), business_id)
    AND (has_role(auth.uid(), 'super_admin') OR has_role(auth.uid(), 'admin'))
    AND is_published = false);

ALTER TABLE public.mf_loan_products
  ADD CONSTRAINT mf_loan_products_current_version_fk
  FOREIGN KEY (current_version_id) REFERENCES public.mf_loan_product_versions(id) ON DELETE SET NULL;

CREATE OR REPLACE FUNCTION public._mf_lpv_freeze_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.is_published THEN
      RAISE EXCEPTION 'Published loan product versions cannot be deleted';
    END IF;
    RETURN OLD;
  END IF;

  IF OLD.is_published THEN
    IF NEW.is_published IS DISTINCT FROM OLD.is_published
       OR NEW.min_amount IS DISTINCT FROM OLD.min_amount
       OR NEW.max_amount IS DISTINCT FROM OLD.max_amount
       OR NEW.min_term_installments IS DISTINCT FROM OLD.min_term_installments
       OR NEW.max_term_installments IS DISTINCT FROM OLD.max_term_installments
       OR NEW.repayment_frequency IS DISTINCT FROM OLD.repayment_frequency
       OR NEW.interest_method IS DISTINCT FROM OLD.interest_method
       OR NEW.interest_rate IS DISTINCT FROM OLD.interest_rate
       OR NEW.interest_rate_period IS DISTINCT FROM OLD.interest_rate_period
       OR NEW.grace_period_installments IS DISTINCT FROM OLD.grace_period_installments
       OR NEW.fees IS DISTINCT FROM OLD.fees
       OR NEW.penalty_rate IS DISTINCT FROM OLD.penalty_rate
       OR NEW.penalty_basis IS DISTINCT FROM OLD.penalty_basis
       OR NEW.eligibility IS DISTINCT FROM OLD.eligibility
       OR NEW.effective_from IS DISTINCT FROM OLD.effective_from
       OR NEW.currency_code IS DISTINCT FROM OLD.currency_code
       OR NEW.version_no IS DISTINCT FROM OLD.version_no THEN
      RAISE EXCEPTION 'Published loan product versions are immutable — publish a new version instead';
    END IF;
  END IF;

  NEW.updated_at := now();
  IF NEW.is_published AND OLD.is_published = false THEN
    NEW.published_at := now();
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER mf_lpv_freeze_guard
  BEFORE UPDATE OR DELETE ON public.mf_loan_product_versions
  FOR EACH ROW EXECUTE FUNCTION public._mf_lpv_freeze_guard();

CREATE OR REPLACE FUNCTION public._mf_lpv_assign_version_no()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF NEW.version_no IS NULL OR NEW.version_no <= 0 THEN
    SELECT COALESCE(MAX(version_no), 0) + 1 INTO NEW.version_no
    FROM public.mf_loan_product_versions WHERE product_id = NEW.product_id;
  END IF;
  IF NEW.is_published THEN
    NEW.published_at := COALESCE(NEW.published_at, now());
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER mf_lpv_assign_version_no
  BEFORE INSERT ON public.mf_loan_product_versions
  FOR EACH ROW EXECUTE FUNCTION public._mf_lpv_assign_version_no();

CREATE OR REPLACE FUNCTION public._mf_loan_products_touch()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER mf_loan_products_touch
  BEFORE UPDATE ON public.mf_loan_products
  FOR EACH ROW EXECUTE FUNCTION public._mf_loan_products_touch();