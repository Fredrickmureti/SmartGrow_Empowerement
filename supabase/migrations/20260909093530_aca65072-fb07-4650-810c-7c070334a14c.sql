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
  v_prod public.mf_loan_products%ROWTYPE;
  v_ver public.mf_loan_product_versions%ROWTYPE;
  v_client public.mf_clients%ROWTYPE;
  v_elig jsonb;
  v_cycles integer;
  v_age integer;
  v_group_business uuid;
  v_submitting boolean := false;
BEGIN
  -- ---------------------------------------------------------------------
  -- Coherence + version pinning. The pricing version is a server decision:
  -- the browser may propose one, but it only survives if it belongs to this
  -- product and institution, is published, and is already in force.
  -- ---------------------------------------------------------------------
  IF TG_OP = 'INSERT' OR NEW.product_id IS DISTINCT FROM OLD.product_id
     OR NEW.product_version_id IS DISTINCT FROM OLD.product_version_id
     OR NEW.client_id IS DISTINCT FROM OLD.client_id
     OR NEW.branch_id IS DISTINCT FROM OLD.branch_id
     OR NEW.group_id IS DISTINCT FROM OLD.group_id THEN

    SELECT * INTO v_prod FROM public.mf_loan_products WHERE id = NEW.product_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'That loan product does not exist';
    END IF;
    IF v_prod.business_id <> NEW.business_id THEN
      RAISE EXCEPTION 'That loan product belongs to another institution';
    END IF;

    SELECT * INTO v_client FROM public.mf_clients WHERE id = NEW.client_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'That client does not exist';
    END IF;
    IF v_client.business_id <> NEW.business_id THEN
      RAISE EXCEPTION 'That client belongs to another institution';
    END IF;
    IF NEW.branch_id IS NOT NULL AND v_client.branch_id IS NOT NULL
       AND NEW.branch_id <> v_client.branch_id
       AND NOT has_role(auth.uid(), 'admin') THEN
      RAISE EXCEPTION 'An application must be booked in the client''s own branch';
    END IF;

    IF NEW.group_id IS NOT NULL THEN
      SELECT business_id INTO v_group_business FROM public.mf_groups WHERE id = NEW.group_id;
      IF v_group_business IS NULL OR v_group_business <> NEW.business_id THEN
        RAISE EXCEPTION 'That group belongs to another institution';
      END IF;
      IF NOT EXISTS (
        SELECT 1 FROM public.mf_group_members
         WHERE group_id = NEW.group_id AND client_id = NEW.client_id
      ) THEN
        RAISE EXCEPTION 'That client is not a member of the selected group';
      END IF;
    END IF;

    -- Once the application has left draft its pricing version is history.
    IF TG_OP = 'UPDATE' AND OLD.status <> 'draft'
       AND NEW.product_version_id IS DISTINCT FROM OLD.product_version_id THEN
      RAISE EXCEPTION 'The loan product version an application was priced on cannot be changed after submission';
    END IF;

    IF TG_OP = 'UPDATE' AND OLD.status <> 'draft' THEN
      NEW.product_version_id := OLD.product_version_id;
    ELSE
      IF NEW.product_version_id IS NOT NULL THEN
        SELECT * INTO v_ver FROM public.mf_loan_product_versions
         WHERE id = NEW.product_version_id;
        IF NOT FOUND
           OR v_ver.product_id <> NEW.product_id
           OR v_ver.business_id <> NEW.business_id
           OR NOT v_ver.is_published
           OR v_ver.effective_from > CURRENT_DATE THEN
          RAISE EXCEPTION 'That loan product version cannot price this application';
        END IF;
      ELSE
        SELECT * INTO v_ver FROM public.mf_loan_product_versions
         WHERE product_id = NEW.product_id
           AND business_id = NEW.business_id
           AND is_published
           AND effective_from <= CURRENT_DATE
         ORDER BY version_no DESC
         LIMIT 1;
        IF NOT FOUND THEN
          RAISE EXCEPTION 'That loan product has no published version in force and cannot be lent on';
        END IF;
        NEW.product_version_id := v_ver.id;
      END IF;
    END IF;
  END IF;

  -- Submission is the point the product's eligibility rules bite.
  v_submitting := (TG_OP = 'INSERT' AND NEW.status = 'submitted')
    OR (TG_OP = 'UPDATE' AND NEW.status = 'submitted' AND OLD.status <> 'submitted');

  IF v_submitting THEN
    SELECT eligibility INTO v_elig FROM public.mf_loan_product_versions
     WHERE id = NEW.product_version_id;
    v_elig := COALESCE(v_elig, '{}'::jsonb);

    SELECT completed_cycles, date_of_birth INTO v_cycles, v_age
      FROM (SELECT completed_cycles,
                   CASE WHEN date_of_birth IS NULL THEN NULL
                        ELSE date_part('year', age(date_of_birth))::integer END AS date_of_birth
              FROM public.mf_clients WHERE id = NEW.client_id) s;

    IF v_elig ? 'min_completed_cycles'
       AND COALESCE(v_cycles, 0) < (v_elig->>'min_completed_cycles')::integer THEN
      RAISE EXCEPTION 'This product requires at least % completed loan cycle(s)',
        (v_elig->>'min_completed_cycles');
    END IF;
    IF v_elig ? 'max_completed_cycles'
       AND COALESCE(v_cycles, 0) > (v_elig->>'max_completed_cycles')::integer THEN
      RAISE EXCEPTION 'This product is limited to clients with at most % completed loan cycle(s)',
        (v_elig->>'max_completed_cycles');
    END IF;
    IF v_elig ? 'min_age' THEN
      IF v_age IS NULL THEN
        RAISE EXCEPTION 'This product has an age rule — record the client''s date of birth first';
      END IF;
      IF v_age < (v_elig->>'min_age')::integer THEN
        RAISE EXCEPTION 'This product requires the client to be at least % years old',
          (v_elig->>'min_age');
      END IF;
    END IF;
    IF v_elig ? 'max_age' THEN
      IF v_age IS NULL THEN
        RAISE EXCEPTION 'This product has an age rule — record the client''s date of birth first';
      END IF;
      IF v_age > (v_elig->>'max_age')::integer THEN
        RAISE EXCEPTION 'This product is limited to clients up to % years old',
          (v_elig->>'max_age');
      END IF;
    END IF;
    IF COALESCE((v_elig->>'requires_group_membership')::boolean, false)
       AND NOT EXISTS (
         SELECT 1 FROM public.mf_group_members WHERE client_id = NEW.client_id
       ) THEN
      RAISE EXCEPTION 'This product requires the client to belong to a group';
    END IF;
  END IF;

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
      IF NOT (has_role(auth.uid(), 'admin')
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