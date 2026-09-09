CREATE OR REPLACE FUNCTION public.reset_module__microfinance(org_id uuid, include_clients boolean DEFAULT false)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE v jsonb := '{}'::jsonb; n bigint; b uuid[];
BEGIN
  SELECT coalesce(array_agg(id), '{}'::uuid[]) INTO b FROM businesses WHERE organization_id = org_id;

  -- M-Pesa collection records point at clients, loans and repayments.
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

  RETURN v;
END;
$fn$;