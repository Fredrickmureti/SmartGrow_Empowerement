-- ============================================================
-- Landed Cost Reconstruction — Step 4: posting & reversal
-- ============================================================

CREATE OR REPLACE FUNCTION public.landed_cost_post_voucher(
  p_voucher_id uuid,
  p_actor uuid DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v RECORD;
  v_actor uuid := COALESCE(p_actor, auth.uid());
  v_date date;
  v_inventory_acct uuid;
  v_cogs_acct uuid;
  v_clearing_acct uuid;
  v_target RECORD;
  v_res jsonb;
  v_cap_total numeric := 0;
  v_exp_total numeric := 0;
  v_noncap RECORD;
  v_lines jsonb := '[]'::jsonb;
  v_credit_total numeric := 0;
  v_je_id uuid;
BEGIN
  SELECT * INTO v FROM public.landed_cost_vouchers WHERE id = p_voucher_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'landed cost voucher % not found', p_voucher_id USING ERRCODE = 'P0002';
  END IF;

  IF v_actor IS NULL OR NOT public.user_has_business_access(v_actor, v.business_id) THEN
    RAISE EXCEPTION 'access denied' USING ERRCODE = '42501';
  END IF;

  IF v.status <> 'allocated' THEN
    RAISE EXCEPTION 'voucher % must be allocated before posting (currently %)', p_voucher_id, v.status
      USING ERRCODE = 'P0001';
  END IF;

  v_date := COALESCE(v.posting_date, v.voucher_date, CURRENT_DATE);

  IF public.is_period_locked(v.organization_id, v.business_id, v_date) THEN
    RAISE EXCEPTION 'accounting period for % is closed', v_date USING ERRCODE = 'P0001';
  END IF;

  v_inventory_acct := public.resolve_default_account(v.business_id, 'inventory', v.branch_id);
  v_cogs_acct := public.resolve_default_account(v.business_id, 'cogs', v.branch_id);
  v_clearing_acct := public.resolve_default_account(v.business_id, 'landed_cost_clearing', v.branch_id);

  IF v_inventory_acct IS NULL THEN
    RAISE EXCEPTION 'no Inventory account configured for this business' USING ERRCODE = 'P0001';
  END IF;
  IF v_clearing_acct IS NULL THEN
    RAISE EXCEPTION 'no Landed Cost Clearing account configured — map the "landed_cost_clearing" role first'
      USING ERRCODE = 'P0001';
  END IF;

  -- ---- Inventory effect: one revaluation per receipt line ----
  FOR v_target IN
    SELECT a.goods_receipt_item_id AS gri_id,
           SUM(a.allocated_amount) AS amount
      FROM public.landed_cost_allocations a
      JOIN public.landed_cost_components c ON c.id = a.component_id
     WHERE a.voucher_id = p_voucher_id
       AND c.is_capitalizable IS TRUE
     GROUP BY a.goods_receipt_item_id
    HAVING SUM(a.allocated_amount) <> 0
  LOOP
    v_res := public.inventory_apply_cost_revaluation(
      v_target.gri_id, v_target.amount, 'landed_cost_voucher', p_voucher_id, v_actor);

    v_cap_total := v_cap_total + COALESCE((v_res->>'capitalized')::numeric, 0);
    v_exp_total := v_exp_total + COALESCE((v_res->>'expensed')::numeric, 0);

    UPDATE public.landed_cost_allocations a
       SET capitalized_amount = ROUND(a.allocated_amount
             * COALESCE((v_res->>'capitalized')::numeric, 0) / NULLIF(v_target.amount, 0), 2),
           expensed_amount = a.allocated_amount - ROUND(a.allocated_amount
             * COALESCE((v_res->>'capitalized')::numeric, 0) / NULLIF(v_target.amount, 0), 2),
           revaluation_result = v_res
     WHERE a.voucher_id = p_voucher_id
       AND a.goods_receipt_item_id = v_target.gri_id;
  END LOOP;

  IF v_exp_total <> 0 AND v_cogs_acct IS NULL THEN
    RAISE EXCEPTION
      'part of this landed cost belongs to stock already sold, but no Cost of Goods Sold account is configured'
      USING ERRCODE = 'P0001';
  END IF;

  IF v_cap_total <> 0 THEN
    v_lines := v_lines || jsonb_build_array(jsonb_build_object(
      'account_id', v_inventory_acct, 'debit', v_cap_total, 'credit', 0,
      'description', 'Landed cost capitalised to inventory — ' || COALESCE(v.voucher_number, '')));
  END IF;

  IF v_exp_total <> 0 THEN
    v_lines := v_lines || jsonb_build_array(jsonb_build_object(
      'account_id', v_cogs_acct, 'debit', v_exp_total, 'credit', 0,
      'description', 'Landed cost on stock already sold — ' || COALESCE(v.voucher_number, '')));
  END IF;

  v_credit_total := v_cap_total + v_exp_total;

  -- ---- Non-capitalisable charges go straight to expense ----
  FOR v_noncap IN
    SELECT c.id, c.description, c.base_amount,
           COALESCE(c.expense_account_id, t.expense_account_id) AS account_id
      FROM public.landed_cost_components c
      LEFT JOIN public.landed_cost_component_types t ON t.id = c.component_type_id
     WHERE c.voucher_id = p_voucher_id
       AND c.is_capitalizable IS NOT TRUE
       AND c.base_amount <> 0
  LOOP
    IF v_noncap.account_id IS NULL THEN
      RAISE EXCEPTION 'non-capitalisable charge "%" has no expense account',
        COALESCE(v_noncap.description, v_noncap.id::text) USING ERRCODE = 'P0001';
    END IF;
    v_lines := v_lines || jsonb_build_array(jsonb_build_object(
      'account_id', v_noncap.account_id, 'debit', v_noncap.base_amount, 'credit', 0,
      'description', COALESCE(v_noncap.description, 'Landed cost charge')));
    v_credit_total := v_credit_total + v_noncap.base_amount;
  END LOOP;

  IF v_credit_total = 0 THEN
    RAISE EXCEPTION 'voucher % has nothing to post', p_voucher_id USING ERRCODE = 'P0001';
  END IF;

  v_lines := v_lines || jsonb_build_array(jsonb_build_object(
    'account_id', v_clearing_acct, 'debit', 0, 'credit', v_credit_total,
    'description', 'Landed cost clearing — ' || COALESCE(v.voucher_number, ''),
    'contact_id', v.vendor_id));

  v_je_id := public.post_journal_entry_atomic(
    v.organization_id, v.business_id,
    public.generate_next_je_number(v.organization_id, v.business_id),
    v_date,
    COALESCE(v.voucher_number, 'Landed cost'),
    'Landed cost voucher ' || COALESCE(v.voucher_number, p_voucher_id::text),
    'landed_cost_voucher', p_voucher_id, v_actor, false, false,
    v_lines, v.currency, v.exchange_rate, 'main', v.branch_id);

  UPDATE public.landed_cost_vouchers
     SET status = 'posted', posted_at = now(), posted_by = v_actor,
         posting_date = v_date, journal_entry_id = v_je_id,
         capitalized_amount = v_cap_total, expensed_amount = v_exp_total
   WHERE id = p_voucher_id;

  PERFORM public.emit_business_event(
    v.organization_id, v.business_id, 'landed_cost.posted',
    'landed_cost_voucher', p_voucher_id,
    'landed_cost.posted:' || p_voucher_id::text,
    jsonb_build_object(
      'voucher_id', p_voucher_id,
      'voucher_number', v.voucher_number,
      'capitalized_amount', v_cap_total,
      'expensed_amount', v_exp_total,
      'journal_entry_id', v_je_id),
    v.branch_id, NULL);

  RETURN jsonb_build_object(
    'voucher_id', p_voucher_id, 'status', 'posted',
    'journal_entry_id', v_je_id,
    'capitalized_amount', v_cap_total,
    'expensed_amount', v_exp_total);
END;
$$;

REVOKE ALL ON FUNCTION public.landed_cost_post_voucher(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.landed_cost_post_voucher(uuid, uuid) TO authenticated, service_role;

COMMENT ON FUNCTION public.landed_cost_post_voucher(uuid, uuid) IS
  'Posts a landed cost voucher: revalues remaining stock, expenses the consumed share to COGS, and books the clearing journal.';

-- ------------------------------------------------------------
-- Reversal
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.landed_cost_reverse_voucher(
  p_voucher_id uuid,
  p_reason text,
  p_actor uuid DEFAULT NULL
) RETURNS jsonb
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

  v_res := public.inventory_reverse_cost_revaluation('landed_cost_voucher', p_voucher_id, v_actor);

  SELECT jsonb_agg(jsonb_build_object(
           'account_id', l.account_id,
           'debit', l.credit,
           'credit', l.debit,
           'description', 'Reversal — ' || COALESCE(l.description, ''),
           'contact_id', l.contact_id))
    INTO v_lines
    FROM public.journal_entry_lines l
   WHERE l.journal_entry_id = v.journal_entry_id;

  IF v_lines IS NULL OR jsonb_array_length(v_lines) < 2 THEN
    RAISE EXCEPTION 'original journal entry for voucher % not found', p_voucher_id USING ERRCODE = 'P0001';
  END IF;

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

  PERFORM public.emit_business_event(
    v.organization_id, v.business_id, 'landed_cost.reversed',
    'landed_cost_voucher', p_voucher_id,
    'landed_cost.reversed:' || p_voucher_id::text,
    jsonb_build_object('voucher_id', p_voucher_id, 'reason', p_reason,
                       'reversal_journal_entry_id', v_je_id,
                       'inventory', v_res),
    v.branch_id, NULL);

  RETURN jsonb_build_object('voucher_id', p_voucher_id, 'status', 'reversed',
                            'reversal_journal_entry_id', v_je_id, 'inventory', v_res);
END;
$$;

REVOKE ALL ON FUNCTION public.landed_cost_reverse_voucher(uuid, text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.landed_cost_reverse_voucher(uuid, text, uuid) TO authenticated, service_role;

COMMENT ON FUNCTION public.landed_cost_reverse_voucher(uuid, text, uuid) IS
  'Reverses a posted landed cost voucher: unwinds the inventory revaluation and books the mirror journal entry.';
