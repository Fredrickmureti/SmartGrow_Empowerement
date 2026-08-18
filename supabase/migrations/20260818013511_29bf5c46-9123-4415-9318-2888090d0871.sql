-- Phase 4d — server-owned write seam for bank rule authoring (V5)

CREATE OR REPLACE FUNCTION public.bank_reconciliation_rule_upsert(
  _business_id uuid,
  _payload jsonb,
  _id uuid DEFAULT NULL
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_org uuid;
  v_id uuid;
  v_bank_account_id uuid := NULLIF(_payload->>'bank_account_id','')::uuid;
  v_counterpart uuid := NULLIF(_payload->>'counterpart_account_id','')::uuid;
  v_sign text := COALESCE(NULLIF(_payload->>'amount_sign',''),'any');
BEGIN
  IF _business_id IS NULL THEN
    RAISE EXCEPTION 'BANK_RULE_BUSINESS_REQUIRED' USING ERRCODE = '22023';
  END IF;
  PERFORM public.assert_can_reconcile_bank(_business_id);

  SELECT b.organization_id INTO v_org FROM public.businesses b WHERE b.id = _business_id;
  IF v_org IS NULL THEN
    RAISE EXCEPTION 'BANK_RULE_UNKNOWN_BUSINESS' USING ERRCODE = '22023';
  END IF;

  IF v_sign NOT IN ('debit','credit','any') THEN
    RAISE EXCEPTION 'BANK_RULE_INVALID_AMOUNT_SIGN: %', v_sign USING ERRCODE = '22023';
  END IF;

  IF v_counterpart IS NULL THEN
    RAISE EXCEPTION 'BANK_RULE_COUNTERPART_ACCOUNT_REQUIRED' USING ERRCODE = '22023';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.accounts a
    WHERE a.id = v_counterpart AND a.business_id = _business_id
  ) THEN
    RAISE EXCEPTION 'BANK_RULE_COUNTERPART_ACCOUNT_FOREIGN' USING ERRCODE = '42501';
  END IF;

  IF v_bank_account_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.bank_accounts ba
    WHERE ba.id = v_bank_account_id AND ba.business_id = _business_id
  ) THEN
    RAISE EXCEPTION 'BANK_RULE_BANK_ACCOUNT_FOREIGN' USING ERRCODE = '42501';
  END IF;

  IF _id IS NULL THEN
    INSERT INTO public.bank_reconciliation_rules (
      organization_id, business_id, bank_account_id, name, priority, is_active,
      description_pattern, description_regex, reference_pattern,
      amount_min, amount_max, amount_sign,
      counterpart_contact_id, counterpart_account_id, journal_book_id,
      auto_post, description_template, created_by
    ) VALUES (
      v_org, _business_id, v_bank_account_id,
      COALESCE(NULLIF(_payload->>'name',''), 'Untitled rule'),
      COALESCE((_payload->>'priority')::int, 100),
      COALESCE((_payload->>'is_active')::boolean, true),
      NULLIF(_payload->>'description_pattern',''),
      NULLIF(_payload->>'description_regex',''),
      NULLIF(_payload->>'reference_pattern',''),
      NULLIF(_payload->>'amount_min','')::numeric,
      NULLIF(_payload->>'amount_max','')::numeric,
      v_sign,
      NULLIF(_payload->>'counterpart_contact_id','')::uuid,
      v_counterpart,
      NULLIF(_payload->>'journal_book_id','')::uuid,
      COALESCE((_payload->>'auto_post')::boolean, false),
      NULLIF(_payload->>'description_template',''),
      auth.uid()
    ) RETURNING id INTO v_id;
  ELSE
    UPDATE public.bank_reconciliation_rules r SET
      bank_account_id = v_bank_account_id,
      name = COALESCE(NULLIF(_payload->>'name',''), r.name),
      priority = COALESCE((_payload->>'priority')::int, r.priority),
      is_active = COALESCE((_payload->>'is_active')::boolean, r.is_active),
      description_pattern = NULLIF(_payload->>'description_pattern',''),
      description_regex = NULLIF(_payload->>'description_regex',''),
      reference_pattern = NULLIF(_payload->>'reference_pattern',''),
      amount_min = NULLIF(_payload->>'amount_min','')::numeric,
      amount_max = NULLIF(_payload->>'amount_max','')::numeric,
      amount_sign = v_sign,
      counterpart_contact_id = NULLIF(_payload->>'counterpart_contact_id','')::uuid,
      counterpart_account_id = v_counterpart,
      journal_book_id = NULLIF(_payload->>'journal_book_id','')::uuid,
      auto_post = COALESCE((_payload->>'auto_post')::boolean, r.auto_post),
      description_template = NULLIF(_payload->>'description_template',''),
      updated_at = now()
    WHERE r.id = _id AND r.business_id = _business_id
    RETURNING r.id INTO v_id;

    IF v_id IS NULL THEN
      RAISE EXCEPTION 'BANK_RULE_NOT_FOUND_IN_BUSINESS' USING ERRCODE = 'P0002';
    END IF;
  END IF;

  RETURN v_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.bank_reconciliation_rule_delete(_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_business uuid;
BEGIN
  SELECT business_id INTO v_business FROM public.bank_reconciliation_rules WHERE id = _id;
  IF v_business IS NULL THEN
    RAISE EXCEPTION 'BANK_RULE_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;
  PERFORM public.assert_can_reconcile_bank(v_business);
  DELETE FROM public.bank_reconciliation_rules WHERE id = _id;
END;
$$;

CREATE OR REPLACE FUNCTION public.transaction_categorization_rule_upsert(
  _business_id uuid,
  _payload jsonb,
  _id uuid DEFAULT NULL
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_org uuid;
  v_id uuid;
  v_bank_account_id uuid := NULLIF(_payload->>'bank_account_id','')::uuid;
  v_target_account uuid := NULLIF(_payload->>'target_account_id','')::uuid;
  v_offset_account uuid := NULLIF(_payload->>'auto_offset_account_id','')::uuid;
  v_txn_type text := COALESCE(NULLIF(_payload->>'transaction_type',''),'both');
BEGIN
  IF _business_id IS NULL THEN
    RAISE EXCEPTION 'TXN_RULE_BUSINESS_REQUIRED' USING ERRCODE = '22023';
  END IF;
  PERFORM public.assert_can_reconcile_bank(_business_id);

  SELECT b.organization_id INTO v_org FROM public.businesses b WHERE b.id = _business_id;
  IF v_org IS NULL THEN
    RAISE EXCEPTION 'TXN_RULE_UNKNOWN_BUSINESS' USING ERRCODE = '22023';
  END IF;

  IF v_txn_type NOT IN ('both','credit','debit') THEN
    RAISE EXCEPTION 'TXN_RULE_INVALID_TRANSACTION_TYPE: %', v_txn_type USING ERRCODE = '22023';
  END IF;

  IF v_target_account IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.accounts a WHERE a.id = v_target_account AND a.business_id = _business_id
  ) THEN
    RAISE EXCEPTION 'TXN_RULE_TARGET_ACCOUNT_FOREIGN' USING ERRCODE = '42501';
  END IF;
  IF v_offset_account IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.accounts a WHERE a.id = v_offset_account AND a.business_id = _business_id
  ) THEN
    RAISE EXCEPTION 'TXN_RULE_OFFSET_ACCOUNT_FOREIGN' USING ERRCODE = '42501';
  END IF;
  IF v_bank_account_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.bank_accounts ba WHERE ba.id = v_bank_account_id AND ba.business_id = _business_id
  ) THEN
    RAISE EXCEPTION 'TXN_RULE_BANK_ACCOUNT_FOREIGN' USING ERRCODE = '42501';
  END IF;

  IF _id IS NULL THEN
    INSERT INTO public.transaction_categorization_rules (
      organization_id, business_id, rule_name,
      description_pattern, reference_pattern, min_amount, max_amount,
      transaction_type, target_category, target_account_id, priority, is_active,
      auto_action, auto_offset_account_id, auto_post, bank_account_id,
      stop_processing, use_regex
    ) VALUES (
      v_org, _business_id,
      COALESCE(NULLIF(_payload->>'rule_name',''), 'Untitled rule'),
      NULLIF(_payload->>'description_pattern',''),
      NULLIF(_payload->>'reference_pattern',''),
      NULLIF(_payload->>'min_amount','')::numeric,
      NULLIF(_payload->>'max_amount','')::numeric,
      v_txn_type,
      COALESCE(NULLIF(_payload->>'target_category',''), 'uncategorized'),
      v_target_account,
      COALESCE((_payload->>'priority')::int, 0),
      COALESCE((_payload->>'is_active')::boolean, true),
      COALESCE(NULLIF(_payload->>'auto_action',''), 'categorize'),
      v_offset_account,
      COALESCE((_payload->>'auto_post')::boolean, false),
      v_bank_account_id,
      COALESCE((_payload->>'stop_processing')::boolean, false),
      COALESCE((_payload->>'use_regex')::boolean, false)
    ) RETURNING id INTO v_id;
  ELSE
    UPDATE public.transaction_categorization_rules r SET
      rule_name = COALESCE(NULLIF(_payload->>'rule_name',''), r.rule_name),
      description_pattern = CASE WHEN _payload ? 'description_pattern' THEN NULLIF(_payload->>'description_pattern','') ELSE r.description_pattern END,
      reference_pattern = CASE WHEN _payload ? 'reference_pattern' THEN NULLIF(_payload->>'reference_pattern','') ELSE r.reference_pattern END,
      min_amount = CASE WHEN _payload ? 'min_amount' THEN NULLIF(_payload->>'min_amount','')::numeric ELSE r.min_amount END,
      max_amount = CASE WHEN _payload ? 'max_amount' THEN NULLIF(_payload->>'max_amount','')::numeric ELSE r.max_amount END,
      transaction_type = CASE WHEN _payload ? 'transaction_type' THEN v_txn_type ELSE r.transaction_type END,
      target_category = COALESCE(NULLIF(_payload->>'target_category',''), r.target_category),
      target_account_id = CASE WHEN _payload ? 'target_account_id' THEN v_target_account ELSE r.target_account_id END,
      priority = COALESCE((_payload->>'priority')::int, r.priority),
      is_active = COALESCE((_payload->>'is_active')::boolean, r.is_active),
      auto_action = COALESCE(NULLIF(_payload->>'auto_action',''), r.auto_action),
      auto_offset_account_id = CASE WHEN _payload ? 'auto_offset_account_id' THEN v_offset_account ELSE r.auto_offset_account_id END,
      auto_post = COALESCE((_payload->>'auto_post')::boolean, r.auto_post),
      bank_account_id = CASE WHEN _payload ? 'bank_account_id' THEN v_bank_account_id ELSE r.bank_account_id END,
      stop_processing = COALESCE((_payload->>'stop_processing')::boolean, r.stop_processing),
      use_regex = COALESCE((_payload->>'use_regex')::boolean, r.use_regex),
      updated_at = now()
    WHERE r.id = _id AND r.business_id = _business_id
    RETURNING r.id INTO v_id;

    IF v_id IS NULL THEN
      RAISE EXCEPTION 'TXN_RULE_NOT_FOUND_IN_BUSINESS' USING ERRCODE = 'P0002';
    END IF;
  END IF;

  RETURN v_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.transaction_categorization_rule_delete(_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_business uuid;
BEGIN
  SELECT business_id INTO v_business FROM public.transaction_categorization_rules WHERE id = _id;
  IF v_business IS NULL THEN
    RAISE EXCEPTION 'TXN_RULE_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;
  PERFORM public.assert_can_reconcile_bank(v_business);
  DELETE FROM public.transaction_categorization_rules WHERE id = _id;
END;
$$;

DO $$
DECLARE fn text;
BEGIN
  FOREACH fn IN ARRAY ARRAY[
    'public.bank_reconciliation_rule_upsert(uuid, jsonb, uuid)',
    'public.bank_reconciliation_rule_delete(uuid)',
    'public.transaction_categorization_rule_upsert(uuid, jsonb, uuid)',
    'public.transaction_categorization_rule_delete(uuid)'
  ] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', fn);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM anon', fn);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated', fn);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', fn);
  END LOOP;
END $$;

-- The rule tables are now seam-only for interactive callers.
REVOKE INSERT, UPDATE, DELETE ON public.bank_reconciliation_rules FROM authenticated;
REVOKE INSERT, UPDATE, DELETE ON public.transaction_categorization_rules FROM authenticated;