CREATE OR REPLACE FUNCTION public.reset_module__microfinance(org_id uuid, include_clients boolean DEFAULT false)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE v jsonb := '{}'::jsonb; n bigint; b uuid[];
BEGIN
  SELECT coalesce(array_agg(id), '{}'::uuid[]) INTO b FROM businesses WHERE organization_id = org_id;

  WITH d AS (DELETE FROM mf_event_postings WHERE business_id = ANY(b) RETURNING 1) SELECT count(*) INTO n FROM d;
  v := v || jsonb_build_object('mf_event_postings', n);

  WITH d AS (DELETE FROM mf_repayment_allocations WHERE business_id = ANY(b) RETURNING 1) SELECT count(*) INTO n FROM d;
  v := v || jsonb_build_object('mf_repayment_allocations', n);

  WITH d AS (DELETE FROM mf_repayments WHERE business_id = ANY(b) RETURNING 1) SELECT count(*) INTO n FROM d;
  v := v || jsonb_build_object('mf_repayments', n);

  WITH d AS (DELETE FROM mf_repayment_batches WHERE business_id = ANY(b) RETURNING 1) SELECT count(*) INTO n FROM d;
  v := v || jsonb_build_object('mf_repayment_batches', n);

  WITH d AS (DELETE FROM mf_collection_bankings WHERE business_id = ANY(b) RETURNING 1) SELECT count(*) INTO n FROM d;
  v := v || jsonb_build_object('mf_collection_bankings', n);

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
$function$;

CREATE OR REPLACE FUNCTION public.preview_transactional_reset(org_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
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
    'mf_groups_optional', (SELECT count(*) FROM mf_groups WHERE business_id = ANY(b))
  ) INTO v;

  RETURN v;
END;
$function$;

CREATE OR REPLACE FUNCTION public.reset_transactional_data(org_id uuid, confirmation text, include_clients boolean DEFAULT false)
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
  v := v || jsonb_build_object('microfinance', public.reset_module__microfinance(org_id, include_clients));
  v := v || jsonb_build_object('banking', public.reset_module__banking(org_id));
  v := v || jsonb_build_object('transactions_ledger', public.reset_module__transactions_ledger(org_id));
  v := v || jsonb_build_object('finance', public.reset_module__finance(org_id));
  v := v || jsonb_build_object('ancillaries', public.reset_module__ancillaries(org_id));
  v := v || jsonb_build_object('sequences', public.reset_module__sequences(org_id));

  -- Integrity verification (inside the same transaction: a failure rolls everything back)
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
          jsonb_build_object('include_clients', include_clients, 'result', 'success', 'counts', v));

  RETURN jsonb_build_object('success', true, 'details', v);
END;
$function$;

CREATE OR REPLACE FUNCTION public.reset_categories(org_id uuid, categories text[])
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_counts jsonb := '{}'::jsonb;
  cat text;
BEGIN
  PERFORM public._assert_reset_permission(org_id);

  IF categories IS NULL OR cardinality(categories) = 0 THEN
    RAISE EXCEPTION 'No categories provided' USING ERRCODE='22023';
  END IF;

  PERFORM set_config('app.reset_in_progress', org_id::text, true);

  v_counts := v_counts || jsonb_build_object('audit_unlinks', public.reset_module__unlink_audit_refs(org_id));

  FOREACH cat IN ARRAY categories LOOP
    IF cat = 'pos' THEN
      v_counts := v_counts || jsonb_build_object('pos', public.reset_module__pos(org_id));
    ELSIF cat = 'warehouse' THEN
      v_counts := v_counts || jsonb_build_object('warehouse', public.reset_module__warehouse(org_id));
    ELSIF cat = 'inventory' THEN
      v_counts := v_counts || jsonb_build_object('inventory', public.reset_module__inventory(org_id));
    ELSIF cat = 'fixed_assets' THEN
      v_counts := v_counts || jsonb_build_object('fixed_assets', public.reset_module__fixed_assets(org_id));
    ELSIF cat = 'vendor_returns' THEN
      v_counts := v_counts || jsonb_build_object('vendor_returns', public.reset_module__vendor_returns(org_id));
    ELSIF cat = 'ancillaries' THEN
      v_counts := v_counts || jsonb_build_object('ancillaries', public.reset_module__ancillaries(org_id));
    ELSIF cat = 'banking' THEN
      v_counts := v_counts || jsonb_build_object('banking', public.reset_module__banking(org_id));
    ELSIF cat = 'transactions_ledger' THEN
      v_counts := v_counts || jsonb_build_object('transactions_ledger', public.reset_module__transactions_ledger(org_id));
    ELSIF cat = 'sales' THEN
      v_counts := v_counts || jsonb_build_object('sales', public.reset_module__sales(org_id));
    ELSIF cat = 'purchases' THEN
      v_counts := v_counts || jsonb_build_object('purchases', public.reset_module__purchases(org_id));
    ELSIF cat = 'finance' THEN
      v_counts := v_counts || jsonb_build_object('finance', public.reset_module__finance(org_id));
    ELSIF cat = 'microfinance' THEN
      v_counts := v_counts || jsonb_build_object('microfinance', public.reset_module__microfinance(org_id));
    ELSIF cat = 'sequences' THEN
      v_counts := v_counts || jsonb_build_object('sequences', public.reset_module__sequences(org_id));
    ELSE
      RAISE EXCEPTION 'Unknown category: %', cat USING ERRCODE='22023';
    END IF;
  END LOOP;

  RETURN jsonb_build_object('success', true, 'details', v_counts);
END;
$function$;

REVOKE ALL ON FUNCTION public.reset_module__microfinance(uuid, boolean) FROM public, anon, authenticated;
REVOKE ALL ON FUNCTION public.reset_transactional_data(uuid, text, boolean) FROM public, anon;
REVOKE ALL ON FUNCTION public.preview_transactional_reset(uuid) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.reset_transactional_data(uuid, text, boolean) TO authenticated;
GRANT EXECUTE ON FUNCTION public.preview_transactional_reset(uuid) TO authenticated;