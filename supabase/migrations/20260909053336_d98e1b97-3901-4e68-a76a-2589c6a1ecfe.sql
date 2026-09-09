-- 1) Let the published-version freeze guard stand aside during an authorised reset.
CREATE OR REPLACE FUNCTION public._mf_lpv_freeze_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $function$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.is_published AND coalesce(current_setting('app.reset_in_progress', true), '') = '' THEN
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
$function$;

-- 2) Microfinance module gains an opt-in loan-product teardown, run last.
CREATE OR REPLACE FUNCTION public.reset_module__microfinance(
  org_id uuid,
  include_clients boolean DEFAULT false,
  include_products boolean DEFAULT false
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE v jsonb := '{}'::jsonb; n bigint; b uuid[];
BEGIN
  SELECT coalesce(array_agg(id), '{}'::uuid[]) INTO b FROM businesses WHERE organization_id = org_id;

  WITH d AS (DELETE FROM mpesa_c2b_transactions WHERE organization_id = org_id RETURNING 1)
  SELECT count(*) INTO n FROM d;
  v := v || jsonb_build_object('mpesa_c2b_transactions', n);

  WITH d AS (DELETE FROM mf_event_postings WHERE business_id = ANY(b) RETURNING 1) SELECT count(*) INTO n FROM d;
  v := v || jsonb_build_object('mf_event_postings', n);

  WITH d AS (DELETE FROM mf_repayment_allocations WHERE business_id = ANY(b) RETURNING 1) SELECT count(*) INTO n FROM d;
  v := v || jsonb_build_object('mf_repayment_allocations', n);

  WITH d AS (DELETE FROM mf_collection_bankings WHERE business_id = ANY(b) RETURNING 1) SELECT count(*) INTO n FROM d;
  v := v || jsonb_build_object('mf_collection_bankings', n);

  WITH d AS (DELETE FROM mf_repayments WHERE business_id = ANY(b) RETURNING 1) SELECT count(*) INTO n FROM d;
  v := v || jsonb_build_object('mf_repayments', n);

  WITH d AS (DELETE FROM mf_repayment_batches WHERE business_id = ANY(b) RETURNING 1) SELECT count(*) INTO n FROM d;
  v := v || jsonb_build_object('mf_repayment_batches', n);

  WITH d AS (DELETE FROM mf_collection_activities WHERE business_id = ANY(b) RETURNING 1) SELECT count(*) INTO n FROM d;
  v := v || jsonb_build_object('mf_collection_activities', n);

  WITH d AS (DELETE FROM mf_loan_charges WHERE business_id = ANY(b) RETURNING 1) SELECT count(*) INTO n FROM d;
  v := v || jsonb_build_object('mf_loan_charges', n);

  WITH d AS (DELETE FROM mf_client_charges WHERE business_id = ANY(b) RETURNING 1) SELECT count(*) INTO n FROM d;
  v := v || jsonb_build_object('mf_client_charges', n);

  WITH d AS (DELETE FROM mf_loan_schedule WHERE business_id = ANY(b) RETURNING 1) SELECT count(*) INTO n FROM d;
  v := v || jsonb_build_object('mf_loan_schedule', n);

  WITH d AS (DELETE FROM mf_loan_disbursements WHERE business_id = ANY(b) RETURNING 1) SELECT count(*) INTO n FROM d;
  v := v || jsonb_build_object('mf_loan_disbursements', n);

  WITH d AS (DELETE FROM mf_loan_events WHERE business_id = ANY(b) RETURNING 1) SELECT count(*) INTO n FROM d;
  v := v || jsonb_build_object('mf_loan_events', n);

  WITH d AS (DELETE FROM loan_lifecycle_events WHERE organization_id = org_id RETURNING 1) SELECT count(*) INTO n FROM d;
  v := v || jsonb_build_object('loan_lifecycle_events', n);

  WITH d AS (DELETE FROM loan_skip_override_events WHERE organization_id = org_id RETURNING 1) SELECT count(*) INTO n FROM d;
  v := v || jsonb_build_object('loan_skip_override_events', n);

  WITH d AS (DELETE FROM mf_loans WHERE business_id = ANY(b) RETURNING 1) SELECT count(*) INTO n FROM d;
  v := v || jsonb_build_object('mf_loans', n);

  WITH d AS (DELETE FROM mf_application_assessments WHERE business_id = ANY(b) RETURNING 1) SELECT count(*) INTO n FROM d;
  v := v || jsonb_build_object('mf_application_assessments', n);

  WITH d AS (DELETE FROM mf_loan_applications WHERE business_id = ANY(b) RETURNING 1) SELECT count(*) INTO n FROM d;
  v := v || jsonb_build_object('mf_loan_applications', n);

  IF include_clients THEN
    WITH d AS (DELETE FROM mf_group_members WHERE business_id = ANY(b) RETURNING 1) SELECT count(*) INTO n FROM d;
    v := v || jsonb_build_object('mf_group_members', n);
    WITH d AS (DELETE FROM mf_groups WHERE business_id = ANY(b) RETURNING 1) SELECT count(*) INTO n FROM d;
    v := v || jsonb_build_object('mf_groups', n);
    WITH d AS (DELETE FROM mf_clients WHERE business_id = ANY(b) RETURNING 1) SELECT count(*) INTO n FROM d;
    v := v || jsonb_build_object('mf_clients', n);
  END IF;

  -- Loan products are configuration, so they are opt-in and removed only after
  -- every application/loan that referenced them is already gone.
  IF include_products THEN
    WITH d AS (DELETE FROM mf_loan_product_versions
                WHERE product_id IN (SELECT id FROM mf_loan_products WHERE business_id = ANY(b))
                RETURNING 1)
    SELECT count(*) INTO n FROM d;
    v := v || jsonb_build_object('mf_loan_product_versions', n);

    WITH d AS (DELETE FROM mf_loan_products WHERE business_id = ANY(b) RETURNING 1) SELECT count(*) INTO n FROM d;
    v := v || jsonb_build_object('mf_loan_products', n);
  END IF;

  RETURN v;
END;
$function$;

-- 3) Wrapper gains the flag and records it in the audit row.
CREATE OR REPLACE FUNCTION public.reset_transactional_data(
  org_id uuid,
  confirmation text,
  include_clients boolean DEFAULT false,
  include_products boolean DEFAULT false
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE v jsonb := '{}'::jsonb; v_orphans bigint; v_left bigint; b uuid[];
BEGIN
  PERFORM public._assert_reset_permission(org_id);

  IF confirmation IS DISTINCT FROM 'RESET TRANSACTIONAL DATA' THEN
    RAISE EXCEPTION 'Confirmation phrase required: type RESET TRANSACTIONAL DATA' USING ERRCODE='22023';
  END IF;

  PERFORM set_config('app.reset_in_progress', org_id::text, true);

  SELECT coalesce(array_agg(id), '{}'::uuid[]) INTO b FROM businesses WHERE organization_id = org_id;

  v := v || jsonb_build_object('audit_unlinks', public.reset_module__unlink_audit_refs(org_id));
  v := v || jsonb_build_object('microfinance', public.reset_module__microfinance(org_id, include_clients, include_products));
  v := v || jsonb_build_object('banking', public.reset_module__banking(org_id));
  v := v || jsonb_build_object('transactions_ledger', public.reset_module__transactions_ledger(org_id));
  v := v || jsonb_build_object('finance', public.reset_module__finance(org_id));
  v := v || jsonb_build_object('ancillaries', public.reset_module__ancillaries(org_id));
  v := v || jsonb_build_object('sequences', public.reset_module__sequences(org_id));

  SELECT count(*) INTO v_orphans
    FROM journal_entry_lines jl
   WHERE NOT EXISTS (SELECT 1 FROM journal_entries je WHERE je.id = jl.journal_entry_id);
  IF v_orphans > 0 THEN
    RAISE EXCEPTION 'Reset aborted: % orphaned journal entry lines would remain', v_orphans USING ERRCODE='23503';
  END IF;

  SELECT (SELECT count(*) FROM mf_loans WHERE business_id = ANY(b))
       + (SELECT count(*) FROM mf_repayments WHERE business_id = ANY(b))
       + (SELECT count(*) FROM mf_loan_applications WHERE business_id = ANY(b))
    INTO v_left;
  IF v_left > 0 THEN
    RAISE EXCEPTION 'Reset aborted: % lending records remain after clean-up', v_left USING ERRCODE='23503';
  END IF;

  INSERT INTO admin_audit_log (admin_user_id, action_type, target_org_id, target_entity_type, target_entity_id, details)
  VALUES (auth.uid(), 'reset_transactional_data', org_id, 'organization', org_id::text,
          jsonb_build_object('include_clients', include_clients, 'include_products', include_products,
                             'result', 'success', 'counts', v));

  RETURN jsonb_build_object('success', true, 'details', v);
END;
$function$;

-- 4) Preview reports the optional product counts too.
CREATE OR REPLACE FUNCTION public.preview_transactional_reset(org_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE b uuid[]; v jsonb;
BEGIN
  PERFORM public._assert_reset_permission(org_id);
  SELECT coalesce(array_agg(id), '{}'::uuid[]) INTO b FROM businesses WHERE organization_id = org_id;

  SELECT jsonb_build_object(
    'mf_loan_applications', (SELECT count(*) FROM mf_loan_applications WHERE business_id = ANY(b)),
    'mf_application_assessments', (SELECT count(*) FROM mf_application_assessments WHERE business_id = ANY(b)),
    'mf_loans', (SELECT count(*) FROM mf_loans WHERE business_id = ANY(b)),
    'mf_loan_schedule', (SELECT count(*) FROM mf_loan_schedule WHERE business_id = ANY(b)),
    'mf_loan_disbursements', (SELECT count(*) FROM mf_loan_disbursements WHERE business_id = ANY(b)),
    'mf_loan_charges', (SELECT count(*) FROM mf_loan_charges WHERE business_id = ANY(b)),
    'mf_client_charges', (SELECT count(*) FROM mf_client_charges WHERE business_id = ANY(b)),
    'mf_loan_events', (SELECT count(*) FROM mf_loan_events WHERE business_id = ANY(b)),
    'mf_repayments', (SELECT count(*) FROM mf_repayments WHERE business_id = ANY(b)),
    'mf_repayment_allocations', (SELECT count(*) FROM mf_repayment_allocations WHERE business_id = ANY(b)),
    'mf_repayment_batches', (SELECT count(*) FROM mf_repayment_batches WHERE business_id = ANY(b)),
    'mf_collection_activities', (SELECT count(*) FROM mf_collection_activities WHERE business_id = ANY(b)),
    'mf_collection_bankings', (SELECT count(*) FROM mf_collection_bankings WHERE business_id = ANY(b)),
    'mf_event_postings', (SELECT count(*) FROM mf_event_postings WHERE business_id = ANY(b)),
    'journal_entries', (SELECT count(*) FROM journal_entries WHERE organization_id = org_id),
    'journal_entry_lines', (SELECT count(*) FROM journal_entry_lines jl WHERE EXISTS (SELECT 1 FROM journal_entries je WHERE je.id = jl.journal_entry_id AND je.organization_id = org_id)),
    'payments', (SELECT count(*) FROM payments WHERE organization_id = org_id),
    'bank_transactions', (SELECT count(*) FROM bank_transactions WHERE organization_id = org_id),
    'mf_clients_optional', (SELECT count(*) FROM mf_clients WHERE business_id = ANY(b)),
    'mf_groups_optional', (SELECT count(*) FROM mf_groups WHERE business_id = ANY(b)),
    'mf_loan_products_optional', (SELECT count(*) FROM mf_loan_products WHERE business_id = ANY(b)),
    'mf_loan_product_versions_optional', (SELECT count(*) FROM mf_loan_product_versions v2
        WHERE v2.product_id IN (SELECT id FROM mf_loan_products WHERE business_id = ANY(b)))
  ) INTO v;

  RETURN v;
END;
$function$;

REVOKE ALL ON FUNCTION public.reset_transactional_data(uuid, text, boolean, boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.reset_module__microfinance(uuid, boolean, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.reset_transactional_data(uuid, text, boolean, boolean) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.preview_transactional_reset(uuid) TO authenticated, service_role;