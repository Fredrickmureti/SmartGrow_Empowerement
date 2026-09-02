CREATE OR REPLACE FUNCTION public._mf_application_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
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

  IF OLD.status IN ('approved','rejected','ready_for_disbursement','disbursed','cancelled')
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
      ('approved','ready_for_disbursement'), ('approved','cancelled'),
      ('ready_for_disbursement','disbursed'), ('ready_for_disbursement','cancelled'),
      ('approved','disbursed')
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
$function$;