CREATE TABLE public.mf_loan_applications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
  branch_id uuid NOT NULL,
  application_number text NOT NULL,
  client_id uuid NOT NULL REFERENCES public.mf_clients(id) ON DELETE RESTRICT,
  group_id uuid REFERENCES public.mf_groups(id) ON DELETE SET NULL,
  product_id uuid NOT NULL REFERENCES public.mf_loan_products(id) ON DELETE RESTRICT,
  product_version_id uuid REFERENCES public.mf_loan_product_versions(id) ON DELETE RESTRICT,
  loan_officer_id uuid,
  requested_amount numeric(18,2) NOT NULL,
  requested_term_installments integer NOT NULL,
  purpose text,
  status text NOT NULL DEFAULT 'draft',
  submitted_at timestamptz,
  submitted_by uuid,
  review_started_at timestamptz,
  approved_amount numeric(18,2),
  approved_term_installments integer,
  decision_by uuid,
  decision_at timestamptz,
  decision_notes text,
  rejection_reason text,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT mf_apps_number_uniq UNIQUE (business_id, application_number),
  CONSTRAINT mf_apps_status_chk CHECK (status IN ('draft','submitted','under_review','approved','rejected','ready_for_disbursement','cancelled')),
  CONSTRAINT mf_apps_requested_chk CHECK (requested_amount > 0 AND requested_term_installments > 0),
  CONSTRAINT mf_apps_approved_chk CHECK (
    (approved_amount IS NULL OR approved_amount > 0)
    AND (approved_term_installments IS NULL OR approved_term_installments > 0)
  )
);

CREATE INDEX mf_apps_client_idx ON public.mf_loan_applications (client_id, created_at DESC);
CREATE INDEX mf_apps_status_idx ON public.mf_loan_applications (business_id, status, created_at DESC);
CREATE INDEX mf_apps_officer_idx ON public.mf_loan_applications (loan_officer_id, status);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.mf_loan_applications TO authenticated;
GRANT ALL ON public.mf_loan_applications TO service_role;

ALTER TABLE public.mf_loan_applications ENABLE ROW LEVEL SECURITY;

CREATE POLICY mf_apps_read ON public.mf_loan_applications
  FOR SELECT TO authenticated
  USING (user_has_business_access(auth.uid(), business_id));

CREATE POLICY mf_apps_insert ON public.mf_loan_applications
  FOR INSERT TO authenticated
  WITH CHECK (user_has_business_access(auth.uid(), business_id));

CREATE POLICY mf_apps_update ON public.mf_loan_applications
  FOR UPDATE TO authenticated
  USING (user_has_business_access(auth.uid(), business_id))
  WITH CHECK (user_has_business_access(auth.uid(), business_id));

CREATE POLICY mf_apps_delete ON public.mf_loan_applications
  FOR DELETE TO authenticated
  USING (user_has_business_access(auth.uid(), business_id)
    AND (has_role(auth.uid(), 'super_admin') OR has_role(auth.uid(), 'admin'))
    AND status IN ('draft','cancelled'));

CREATE TABLE public.mf_application_assessments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
  application_id uuid NOT NULL REFERENCES public.mf_loan_applications(id) ON DELETE CASCADE,
  assessed_by uuid NOT NULL,
  assessed_at timestamptz NOT NULL DEFAULT now(),
  visit_date date NOT NULL DEFAULT CURRENT_DATE,
  visit_location text,
  business_verified boolean NOT NULL DEFAULT false,
  monthly_income numeric(18,2) NOT NULL DEFAULT 0,
  monthly_expenses numeric(18,2) NOT NULL DEFAULT 0,
  existing_obligations numeric(18,2) NOT NULL DEFAULT 0,
  collateral_description text,
  character_notes text,
  recommended_amount numeric(18,2),
  recommended_term_installments integer,
  recommendation text NOT NULL DEFAULT 'recommend',
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT mf_assess_recommendation_chk CHECK (recommendation IN ('recommend','decline','refer')),
  CONSTRAINT mf_assess_amounts_chk CHECK (
    monthly_income >= 0 AND monthly_expenses >= 0 AND existing_obligations >= 0
    AND (recommended_amount IS NULL OR recommended_amount > 0)
    AND (recommended_term_installments IS NULL OR recommended_term_installments > 0)
  )
);

CREATE INDEX mf_assess_application_idx ON public.mf_application_assessments (application_id, assessed_at DESC);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.mf_application_assessments TO authenticated;
GRANT ALL ON public.mf_application_assessments TO service_role;

ALTER TABLE public.mf_application_assessments ENABLE ROW LEVEL SECURITY;

CREATE POLICY mf_assess_read ON public.mf_application_assessments
  FOR SELECT TO authenticated
  USING (user_has_business_access(auth.uid(), business_id));

CREATE POLICY mf_assess_insert ON public.mf_application_assessments
  FOR INSERT TO authenticated
  WITH CHECK (user_has_business_access(auth.uid(), business_id) AND assessed_by = auth.uid());

CREATE POLICY mf_assess_update ON public.mf_application_assessments
  FOR UPDATE TO authenticated
  USING (user_has_business_access(auth.uid(), business_id)
    AND (assessed_by = auth.uid() OR has_role(auth.uid(), 'super_admin') OR has_role(auth.uid(), 'admin')))
  WITH CHECK (user_has_business_access(auth.uid(), business_id));

CREATE POLICY mf_assess_delete ON public.mf_application_assessments
  FOR DELETE TO authenticated
  USING (user_has_business_access(auth.uid(), business_id)
    AND (has_role(auth.uid(), 'super_admin') OR has_role(auth.uid(), 'admin')));

CREATE OR REPLACE FUNCTION public._mf_application_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_allowed boolean := false;
  v_min numeric;
  v_max numeric;
  v_min_term integer;
  v_max_term integer;
  v_assessments integer;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status NOT IN ('draft','submitted') THEN
      RAISE EXCEPTION 'A new application must start as a draft or a submission';
    END IF;
    IF NEW.status = 'submitted' THEN
      NEW.submitted_at := COALESCE(NEW.submitted_at, now());
      NEW.submitted_by := COALESCE(NEW.submitted_by, auth.uid());
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.status IN ('approved','rejected','ready_for_disbursement','cancelled')
     AND NEW.status = OLD.status
     AND (NEW.requested_amount IS DISTINCT FROM OLD.requested_amount
          OR NEW.requested_term_installments IS DISTINCT FROM OLD.requested_term_installments
          OR NEW.client_id IS DISTINCT FROM OLD.client_id
          OR NEW.product_id IS DISTINCT FROM OLD.product_id
          OR NEW.product_version_id IS DISTINCT FROM OLD.product_version_id
          OR NEW.approved_amount IS DISTINCT FROM OLD.approved_amount
          OR NEW.approved_term_installments IS DISTINCT FROM OLD.approved_term_installments) THEN
    RAISE EXCEPTION 'A decided application is a historical record and cannot be edited';
  END IF;

  IF NEW.status IS DISTINCT FROM OLD.status THEN
    v_allowed := (OLD.status, NEW.status) IN (
      ('draft','submitted'), ('draft','cancelled'),
      ('submitted','under_review'), ('submitted','draft'), ('submitted','cancelled'),
      ('under_review','approved'), ('under_review','rejected'), ('under_review','cancelled'),
      ('approved','ready_for_disbursement'), ('approved','cancelled')
    );
    IF NOT v_allowed THEN
      RAISE EXCEPTION 'Applications cannot move from % to %', OLD.status, NEW.status;
    END IF;

    IF NEW.status = 'submitted' THEN
      NEW.submitted_at := COALESCE(NEW.submitted_at, now());
      NEW.submitted_by := COALESCE(NEW.submitted_by, auth.uid());
    END IF;

    IF NEW.status = 'under_review' THEN
      NEW.review_started_at := COALESCE(NEW.review_started_at, now());
    END IF;

    IF NEW.status IN ('approved','rejected') THEN
      IF NOT (has_role(auth.uid(), 'super_admin') OR has_role(auth.uid(), 'admin')
              OR has_role(auth.uid(), 'branch_manager')) THEN
        RAISE EXCEPTION 'Only a branch manager or administrator can decide an application';
      END IF;

      SELECT count(*) INTO v_assessments
      FROM public.mf_application_assessments WHERE application_id = NEW.id;
      IF v_assessments = 0 THEN
        RAISE EXCEPTION 'An application cannot be decided before an assessment is recorded';
      END IF;

      NEW.decision_by := COALESCE(NEW.decision_by, auth.uid());
      NEW.decision_at := COALESCE(NEW.decision_at, now());
    END IF;

    IF NEW.status = 'approved' THEN
      IF NEW.product_version_id IS NULL THEN
        RAISE EXCEPTION 'An approved application must reference the loan product version it was priced on';
      END IF;
      IF NEW.approved_amount IS NULL OR NEW.approved_term_installments IS NULL THEN
        RAISE EXCEPTION 'Record the approved amount and term before approving';
      END IF;

      SELECT min_amount, max_amount, min_term_installments, max_term_installments
        INTO v_min, v_max, v_min_term, v_max_term
      FROM public.mf_loan_product_versions WHERE id = NEW.product_version_id;

      IF NEW.approved_amount < v_min OR NEW.approved_amount > v_max THEN
        RAISE EXCEPTION 'The approved amount is outside the product band of % to %', v_min, v_max;
      END IF;
      IF NEW.approved_term_installments < v_min_term OR NEW.approved_term_installments > v_max_term THEN
        RAISE EXCEPTION 'The approved term is outside the product range of % to % installments', v_min_term, v_max_term;
      END IF;
    END IF;

    IF NEW.status = 'rejected' AND COALESCE(btrim(NEW.rejection_reason), '') = '' THEN
      RAISE EXCEPTION 'Record a reason when rejecting an application';
    END IF;
  END IF;

  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER mf_application_guard
  BEFORE INSERT OR UPDATE ON public.mf_loan_applications
  FOR EACH ROW EXECUTE FUNCTION public._mf_application_guard();

CREATE OR REPLACE FUNCTION public._mf_assessment_touch()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER mf_assessment_touch
  BEFORE UPDATE ON public.mf_application_assessments
  FOR EACH ROW EXECUTE FUNCTION public._mf_assessment_touch();