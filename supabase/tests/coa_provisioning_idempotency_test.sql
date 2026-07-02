-- coa_provisioning_idempotency_test.sql
-- Re-running provision_default_chart_of_accounts MUST be a no-op:
-- no new accounts, no new default_account_settings rows.
BEGIN;
  DO $$
  DECLARE
    v_org uuid; v_biz uuid;
    n_accounts_before int; n_accounts_after int;
    n_settings_before int; n_settings_after int;
  BEGIN
    SELECT organization_id, id INTO v_org, v_biz FROM public.businesses LIMIT 1;
    IF v_biz IS NULL THEN RAISE NOTICE 'no business to test against; skipping'; RETURN; END IF;

    SELECT count(*) INTO n_accounts_before FROM public.accounts WHERE business_id = v_biz;
    SELECT count(*) INTO n_settings_before FROM public.default_account_settings WHERE business_id = v_biz;

    PERFORM public.provision_default_chart_of_accounts(v_org, v_biz, NULL);

    SELECT count(*) INTO n_accounts_after  FROM public.accounts WHERE business_id = v_biz;
    SELECT count(*) INTO n_settings_after  FROM public.default_account_settings WHERE business_id = v_biz;

    IF n_accounts_after <> n_accounts_before THEN
      RAISE EXCEPTION 'coa provisioning is not idempotent: accounts %->%', n_accounts_before, n_accounts_after;
    END IF;
    IF n_settings_after <> n_settings_before THEN
      RAISE EXCEPTION 'coa provisioning is not idempotent: settings %->%', n_settings_before, n_settings_after;
    END IF;
  END $$;
ROLLBACK;
