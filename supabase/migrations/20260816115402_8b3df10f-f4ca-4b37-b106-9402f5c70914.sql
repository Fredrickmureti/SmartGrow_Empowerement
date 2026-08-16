CREATE OR REPLACE FUNCTION public.inventory_reverse_cost_revaluation(
  p_source_type text, p_source_id uuid, p_actor uuid DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row RECORD;
  v_qty_now numeric;
  v_qty_at_apply numeric;
  v_unit_uplift numeric;
  v_unwound numeric;
  v_reversed numeric := 0;
  v_unwound_total numeric := 0;
  v_consumed_total numeric := 0;
  v_count integer := 0;
  v_by_product jsonb := '{}'::jsonb;
  v_key text;
BEGIN
  FOR v_row IN
    SELECT * FROM public.inventory_cost_revaluations
     WHERE source_type = p_source_type AND source_id = p_source_id
       AND reversed_at IS NULL
     FOR UPDATE
  LOOP
    SELECT qty_remaining INTO v_qty_now
      FROM public.cost_layers WHERE id = v_row.layer_id FOR UPDATE;

    v_qty_at_apply := NULLIF(v_row.qty_remaining_at_apply, 0);
    v_qty_now := COALESCE(v_qty_now, 0);

    IF v_qty_at_apply IS NULL THEN
      v_unit_uplift := 0;
      v_unwound := 0;
    ELSE
      v_unit_uplift := v_row.amount_applied / v_qty_at_apply;
      v_unwound := ROUND(v_unit_uplift * LEAST(v_qty_now, v_qty_at_apply), 2);
    END IF;

    IF v_qty_now > 0 AND v_unit_uplift <> 0 THEN
      UPDATE public.cost_layers
         SET unit_cost = GREATEST(unit_cost - v_unit_uplift, 0)
       WHERE id = v_row.layer_id;
    END IF;

    UPDATE public.inventory_cost_revaluations
       SET reversed_at = now(), reversed_by = COALESCE(p_actor, auth.uid())
     WHERE id = v_row.id;

    v_reversed := v_reversed + v_row.amount_applied;
    v_unwound_total := v_unwound_total + v_unwound;
    v_consumed_total := v_consumed_total + (v_row.amount_applied - v_unwound);
    v_count := v_count + 1;

    v_key := v_row.product_id::text;
    v_by_product := jsonb_set(
      v_by_product, ARRAY[v_key],
      jsonb_build_object(
        'unwound', COALESCE((v_by_product #>> ARRAY[v_key, 'unwound'])::numeric, 0) + v_unwound,
        'consumed', COALESCE((v_by_product #>> ARRAY[v_key, 'consumed'])::numeric, 0)
                    + (v_row.amount_applied - v_unwound)),
      true);
  END LOOP;

  RETURN jsonb_build_object(
    'reversed_amount', v_reversed,
    'unwound_amount', v_unwound_total,
    'consumed_amount', v_consumed_total,
    'layers', v_count,
    'by_product', v_by_product);
END;
$$;

REVOKE ALL ON FUNCTION public.inventory_reverse_cost_revaluation(text, uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.inventory_reverse_cost_revaluation(text, uuid, uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.landed_cost_reverse_voucher(
  p_voucher_id uuid, p_reason text, p_actor uuid DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v RECORD;
  v_actor uuid := COALESCE(p_actor, auth.uid());
  v_date date := CURRENT_DATE;
  v_lines jsonb := '[]'::jsonb;
  v_res jsonb;
  v_je_id uuid;
  v_prod RECORD;
  v_inv_acct uuid;
  v_cogs_acct uuid;
  v_line_inv uuid;
  v_line_cogs uuid;
  v_unwound numeric;
  v_cogs_amt numeric;
  v_total numeric := 0;
  v_noncap RECORD;
  v_clearing_acct uuid;
BEGIN
  IF p_reason IS NULL OR btrim(p_reason) = '' THEN
    RAISE EXCEPTION 'a reversal reason is required' USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO v FROM public.landed_cost_vouchers WHERE id = p_voucher_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'landed cost voucher % not found', p_voucher_id USING ERRCODE = 'P0002';
  END IF;

  IF v_actor IS NULL OR NOT public.user_has_business_access(v_actor, v.business_id) THEN
    RAISE EXCEPTION 'access denied' USING ERRCODE = '42501';
  END IF;

  IF v.status <> 'posted' THEN
    RAISE EXCEPTION 'only a posted voucher can be reversed (currently %)', v.status USING ERRCODE = 'P0001';
  END IF;

  IF public.is_period_locked(v.organization_id, v.business_id, v_date) THEN
    RAISE EXCEPTION 'accounting period for % is closed', v_date USING ERRCODE = 'P0001';
  END IF;

  IF v.journal_entry_id IS NULL
     OR NOT EXISTS (SELECT 1 FROM public.journal_entry_lines
                     WHERE journal_entry_id = v.journal_entry_id) THEN
    RAISE EXCEPTION 'original journal entry for voucher % not found', p_voucher_id USING ERRCODE = 'P0001';
  END IF;

  v_inv_acct := public.resolve_posting_account(v.business_id, 'inventory', v.branch_id);
  v_cogs_acct := public.resolve_posting_account(v.business_id, 'cogs', v.branch_id);
  v_clearing_acct := public.resolve_posting_account(v.business_id, 'landed_cost_clearing', v.branch_id);

  IF v_clearing_acct IS NULL THEN
    RAISE EXCEPTION 'no Landed Cost Clearing account configured — map the "landed_cost_clearing" role first'
      USING ERRCODE = 'P0001';
  END IF;

  v_res := public.inventory_reverse_cost_revaluation('landed_cost_voucher', p_voucher_id, v_actor);

  FOR v_prod IN
    SELECT (key)::uuid AS product_id,
           COALESCE((value->>'unwound')::numeric, 0) AS unwound,
           COALESCE((value->>'consumed')::numeric, 0) AS consumed
      FROM jsonb_each(COALESCE(v_res->'by_product', '{}'::jsonb))
     ORDER BY key
  LOOP
    v_unwound := ROUND(v_prod.unwound, 2);
    v_cogs_amt := ROUND(v_prod.consumed, 2);

    IF v_unwound <> 0 THEN
      v_line_inv := COALESCE(
        public.resolve_product_gl_account(v.organization_id, v.business_id, v_prod.product_id, 'inventory'),
        v_inv_acct);
      IF v_line_inv IS NULL THEN
        RAISE EXCEPTION 'no Inventory account resolvable for product % on this reversal', v_prod.product_id
          USING ERRCODE = 'P0001';
      END IF;
      v_lines := v_lines || jsonb_build_array(jsonb_build_object(
        'account_id', v_line_inv, 'debit', 0, 'credit', v_unwound,
        'description', 'Reversal — landed cost capitalised to inventory — ' || COALESCE(v.voucher_number, '')));
      v_total := v_total + v_unwound;
    END IF;

    IF v_cogs_amt <> 0 THEN
      v_line_cogs := COALESCE(
        public.resolve_product_gl_account(v.organization_id, v.business_id, v_prod.product_id, 'cogs'),
        v_cogs_acct);
      IF v_line_cogs IS NULL THEN
        RAISE EXCEPTION
          'part of this landed cost was already relieved through cost of sales, but no Cost of Goods Sold account is configured for product %',
          v_prod.product_id USING ERRCODE = 'P0001';
      END IF;
      v_lines := v_lines || jsonb_build_array(jsonb_build_object(
        'account_id', v_line_cogs, 'debit', 0, 'credit', v_cogs_amt,
        'description', 'Reversal — landed cost on stock sold since posting — ' || COALESCE(v.voucher_number, '')));
      v_total := v_total + v_cogs_amt;
    END IF;
  END LOOP;

  FOR v_prod IN
    SELECT a.product_id, SUM(a.expensed_amount) AS amount
      FROM public.landed_cost_allocations a
      JOIN public.landed_cost_components c ON c.id = a.component_id
     WHERE a.voucher_id = p_voucher_id
       AND c.is_capitalizable IS TRUE
       AND COALESCE(a.expensed_amount, 0) <> 0
     GROUP BY a.product_id
     ORDER BY a.product_id
  LOOP
    v_line_cogs := COALESCE(
      public.resolve_product_gl_account(v.organization_id, v.business_id, v_prod.product_id, 'cogs'),
      v_cogs_acct);
    IF v_line_cogs IS NULL THEN
      RAISE EXCEPTION 'no Cost of Goods Sold account resolvable for product % on this reversal', v_prod.product_id
        USING ERRCODE = 'P0001';
    END IF;
    v_lines := v_lines || jsonb_build_array(jsonb_build_object(
      'account_id', v_line_cogs, 'debit', 0, 'credit', ROUND(v_prod.amount, 2),
      'description', 'Reversal — landed cost on stock already sold — ' || COALESCE(v.voucher_number, '')));
    v_total := v_total + ROUND(v_prod.amount, 2);
  END LOOP;

  FOR v_noncap IN
    SELECT c.id, c.description, c.base_amount,
           COALESCE(c.expense_account_id, t.expense_account_id) AS account_id
      FROM public.landed_cost_components c
      LEFT JOIN public.landed_cost_component_types t ON t.id = c.component_type_id
     WHERE c.voucher_id = p_voucher_id
       AND c.is_capitalizable IS NOT TRUE
       AND c.base_amount <> 0
     ORDER BY c.id
  LOOP
    IF v_noncap.account_id IS NULL THEN
      RAISE EXCEPTION 'non-capitalisable charge "%" has no expense account',
        COALESCE(v_noncap.description, v_noncap.id::text) USING ERRCODE = 'P0001';
    END IF;
    v_lines := v_lines || jsonb_build_array(jsonb_build_object(
      'account_id', v_noncap.account_id, 'debit', 0, 'credit', v_noncap.base_amount,
      'description', 'Reversal — ' || COALESCE(v_noncap.description, 'Landed cost charge')));
    v_total := v_total + v_noncap.base_amount;
  END LOOP;

  IF v_total = 0 THEN
    RAISE EXCEPTION 'voucher % has nothing to reverse', p_voucher_id USING ERRCODE = 'P0001';
  END IF;

  v_lines := v_lines || jsonb_build_array(jsonb_build_object(
    'account_id', v_clearing_acct, 'debit', v_total, 'credit', 0,
    'description', 'Reversal — landed cost clearing — ' || COALESCE(v.voucher_number, ''),
    'contact_id', v.vendor_id));

  v_je_id := public.post_journal_entry_atomic(
    v.organization_id, v.business_id,
    public.generate_next_je_number(v.organization_id, v.business_id),
    v_date,
    COALESCE(v.voucher_number, 'Landed cost') || ' (reversal)',
    'Reversal of landed cost voucher ' || COALESCE(v.voucher_number, p_voucher_id::text) || ' — ' || p_reason,
    'landed_cost_voucher', p_voucher_id, v_actor, false, false,
    v_lines, v.currency, v.exchange_rate, 'reversal', v.branch_id);

  UPDATE public.landed_cost_vouchers
     SET status = 'reversed', reversed_at = now(), reversed_by = v_actor,
         reversal_reason = p_reason, reversal_journal_entry_id = v_je_id,
         capitalized_amount = 0, expensed_amount = 0
   WHERE id = p_voucher_id;

  PERFORM public._emit_landed_cost_outbox(p_voucher_id, 'reversed',
    jsonb_build_object('business_id', v.business_id,
                       'voucher_id', p_voucher_id, 'reason', p_reason,
                       'reversal_journal_entry_id', v_je_id,
                       'inventory', v_res));

  RETURN jsonb_build_object('voucher_id', p_voucher_id, 'status', 'reversed',
                            'reversal_journal_entry_id', v_je_id, 'inventory', v_res);
END;
$$;

REVOKE ALL ON FUNCTION public.landed_cost_reverse_voucher(uuid, text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.landed_cost_reverse_voucher(uuid, text, uuid) TO authenticated, service_role;