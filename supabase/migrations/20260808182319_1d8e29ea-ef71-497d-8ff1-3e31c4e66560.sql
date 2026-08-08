DO $do$
DECLARE
  v_def text;
  v_old text;
  v_new text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.proname = 'complete_delivery_atomic'
     AND pg_get_function_identity_arguments(p.oid) =
         'p_dn_id uuid, p_user_id uuid, p_received_by text, p_pod jsonb, p_received_by_user_id uuid';

  IF v_def IS NULL THEN
    RAISE EXCEPTION 'complete_delivery_atomic not found with the expected signature';
  END IF;

  v_old := $old$    SELECT id INTO v_inventory_acct FROM public.accounts
     WHERE organization_id = v_org_id AND business_id = v_biz_id
       AND detail_type = 'inventory' AND is_active = true LIMIT 1;
    SELECT id INTO v_cogs_acct FROM public.accounts
     WHERE organization_id = v_org_id AND business_id = v_biz_id
       AND detail_type = 'cost_of_goods_sold' AND is_active = true LIMIT 1;

    IF v_inventory_acct IS NOT NULL AND v_cogs_acct IS NOT NULL THEN
      SELECT public.get_next_journal_entry_number(v_org_id) INTO v_entry_no;
      IF v_is_return THEN
        v_cogs_lines := jsonb_build_array(
          jsonb_build_object('account_id', v_inventory_acct, 'debit', v_total_cogs, 'credit', 0,
                             'description', 'Inventory restore - ' || v_dn.delivery_number),
          jsonb_build_object('account_id', v_cogs_acct, 'debit', 0, 'credit', v_total_cogs,
                             'description', 'COGS reversal - ' || v_dn.delivery_number)
        );
      ELSE
        v_cogs_lines := jsonb_build_array(
          jsonb_build_object('account_id', v_cogs_acct, 'debit', v_total_cogs, 'credit', 0,
                             'description', 'COGS - ' || v_dn.delivery_number),
          jsonb_build_object('account_id', v_inventory_acct, 'debit', 0, 'credit', v_total_cogs,
                             'description', 'Inventory reduction - ' || v_dn.delivery_number)
        );
      END IF;$old$;

  v_new := $new$    -- Accounts resolve per line through product -> category -> company default.
    -- cost_at_shipment is already persisted above, so the amounts here are the
    -- same historical costs the stock movements used.
    v_cogs_lines := public.resolve_delivery_cogs_lines(
      p_dn_id, v_org_id, v_biz_id, v_is_return, v_dn.delivery_number);

    IF jsonb_array_length(COALESCE(v_cogs_lines, '[]'::jsonb)) > 0 THEN
      SELECT public.get_next_journal_entry_number(v_org_id) INTO v_entry_no;$new$;

  IF position(v_old IN v_def) = 0 THEN
    RAISE EXCEPTION 'complete_delivery_atomic COGS block does not match the expected source; refusing to patch blindly';
  END IF;

  EXECUTE replace(v_def, v_old, v_new);
END $do$;