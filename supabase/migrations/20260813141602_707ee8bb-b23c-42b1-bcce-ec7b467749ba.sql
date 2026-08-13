-- 1. Canonical posting-account resolver: default_account_settings is the source of
--    truth for account roles; the legacy default_accounts table and heuristics remain
--    a fallback only.
CREATE OR REPLACE FUNCTION public.resolve_posting_account(
  p_business_id uuid,
  p_key text,
  p_branch_id uuid DEFAULT NULL
) RETURNS uuid
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_account_id uuid;
BEGIN
  IF p_branch_id IS NOT NULL THEN
    SELECT s.account_id INTO v_account_id
      FROM public.default_account_settings s
     WHERE s.business_id = p_business_id
       AND s.branch_id = p_branch_id
       AND s.setting_key = p_key;
    IF v_account_id IS NOT NULL THEN RETURN v_account_id; END IF;
  END IF;

  SELECT s.account_id INTO v_account_id
    FROM public.default_account_settings s
   WHERE s.business_id = p_business_id
     AND s.branch_id IS NULL
     AND s.setting_key = p_key;
  IF v_account_id IS NOT NULL THEN RETURN v_account_id; END IF;

  RETURN public.resolve_default_account(p_business_id, p_key, p_branch_id);
END;
$$;

GRANT EXECUTE ON FUNCTION public.resolve_posting_account(uuid, text, uuid) TO authenticated, service_role;

-- 2. Every business needs a Landed Cost Clearing account role. Create the account when
--    absent, then map the role through the canonical settings table.
-- 1b. The clearing role must declare which detail types may carry it.
INSERT INTO public.account_role_eligibility (role_key, account_type, detail_type, priority)
VALUES
  ('landed_cost_clearing', 'liability', 'other_current_liabilities', 1)
ON CONFLICT (role_key, account_type, detail_type) DO NOTHING;

DO $seed$
DECLARE
  b RECORD;
  v_acct uuid;
BEGIN
  FOR b IN SELECT id, organization_id FROM public.businesses LOOP
    IF EXISTS (
      SELECT 1 FROM public.default_account_settings
       WHERE business_id = b.id AND branch_id IS NULL
         AND setting_key = 'landed_cost_clearing'
    ) THEN
      CONTINUE;
    END IF;

    v_acct := public.upsert_system_account(
      b.organization_id, b.id, 'landed_cost_clearing', 'liability',
      'other_current_liabilities', '2099', 'Landed Cost Clearing',
      'Accrues acquisition charges capitalised by landed cost vouchers until the supplier bill for those charges is recorded.',
      NULL, false);

    INSERT INTO public.default_account_settings
      (organization_id, business_id, branch_id, setting_key, account_id, source)
    VALUES (b.organization_id, b.id, NULL, 'landed_cost_clearing', v_acct, 'system_seed')
    ON CONFLICT (organization_id, business_id, branch_id, setting_key) DO NOTHING;
  END LOOP;
END;
$seed$;

-- 3. Posting resolves its accounts through the canonical resolver.
CREATE OR REPLACE FUNCTION public.landed_cost_post_voucher(
  p_voucher_id uuid,
  p_actor uuid DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
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

  v_inventory_acct := public.resolve_posting_account(v.business_id, 'inventory', v.branch_id);
  v_cogs_acct := public.resolve_posting_account(v.business_id, 'cogs', v.branch_id);
  v_clearing_acct := public.resolve_posting_account(v.business_id, 'landed_cost_clearing', v.branch_id);

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
$fn$;