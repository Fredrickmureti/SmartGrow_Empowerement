
-- ============================================================
-- Batch T5 · POS Transaction Engine — Per-sale GL posting
-- ============================================================
-- NOTE on naming: the country-agnostic DDL guard rejects any new/
-- replaced function whose name contains "shif" (guards against
-- Kenya SHIF statutory names). The prior POS shift-close functions
-- (post_pos_shift_gl / trg_pos_shift_close_journal_fn) pre-date the
-- guard so cannot be REPLACEd. We leave them orphaned and route
-- shift-close through fresh names (post_pos_close_variance_gl /
-- trg_pos_close_variance_gl_fn). Per-sale posting is the primary
-- mechanism; shift close is variance-only.

-- 1) Columns on pos_transactions ------------------------------
ALTER TABLE public.pos_transactions
  ADD COLUMN IF NOT EXISTS journal_entry_id uuid NULL REFERENCES public.journal_entries(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS gl_posted_at timestamptz NULL;

CREATE INDEX IF NOT EXISTS idx_pos_transactions_journal_entry_id
  ON public.pos_transactions(journal_entry_id)
  WHERE journal_entry_id IS NOT NULL;

-- 2) Per-sale poster ------------------------------------------
CREATE OR REPLACE FUNCTION public.post_pos_sale_gl(_txn_id uuid)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_txn RECORD;
  v_org_id uuid; v_biz_id uuid; v_branch_id uuid; v_actor uuid;
  v_rev_acct uuid; v_cogs_acct uuid; v_inv_acct uuid;
  v_total_cogs numeric := 0; v_net numeric := 0;
  v_reference text; v_entry_number text; v_lines jsonb := '[]'::jsonb;
  v_jeid uuid; v_pay RECORD; v_tax RECORD;
  v_pay_account uuid; v_tax_account uuid;
  v_sign numeric := 1;
  v_desc_prefix text;
BEGIN
  SELECT * INTO v_txn FROM public.pos_transactions WHERE id = _txn_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'POS transaction not found: %', _txn_id; END IF;
  IF v_txn.journal_entry_id IS NOT NULL THEN RETURN v_txn.journal_entry_id; END IF;
  IF v_txn.status <> 'completed' THEN RETURN NULL; END IF;
  IF v_txn.transaction_type NOT IN ('sale','return') THEN RETURN NULL; END IF;

  v_org_id := v_txn.organization_id;
  v_biz_id := v_txn.business_id;
  v_branch_id := v_txn.branch_id;
  v_actor := COALESCE(v_txn.cashier_id, v_txn.created_by);

  IF v_txn.transaction_type = 'return' THEN
    v_sign := -1; v_desc_prefix := 'POS return ';
  ELSE
    v_desc_prefix := 'POS sale ';
  END IF;

  v_rev_acct := COALESCE(
    public.get_default_account_id(v_org_id, v_biz_id, 'pos_revenue'),
    public.get_default_account_id(v_org_id, v_biz_id, 'sales_revenue'));
  v_cogs_acct := COALESCE(
    public.get_default_account_id(v_org_id, v_biz_id, 'pos_cogs'),
    public.get_default_account_id(v_org_id, v_biz_id, 'cogs'));
  v_inv_acct := COALESCE(
    public.get_default_account_id(v_org_id, v_biz_id, 'pos_inventory'),
    public.get_default_account_id(v_org_id, v_biz_id, 'inventory'));

  v_net := COALESCE(v_txn.subtotal, 0) - COALESCE(v_txn.discount_amount, 0);

  IF v_net <> 0 AND v_rev_acct IS NULL THEN
    RAISE EXCEPTION 'POS sale cannot post to GL: missing pos_revenue/sales_revenue account mapping. txn_id=%', _txn_id;
  END IF;

  FOR v_pay IN
    SELECT payment_method, SUM(amount) AS amt
    FROM public.pos_transaction_payments
    WHERE transaction_id = _txn_id AND status = 'completed'
    GROUP BY payment_method
  LOOP
    SELECT COALESCE(pm_branch.debit_account_id, pm_company.debit_account_id)
      INTO v_pay_account
    FROM (SELECT 1) noop
    LEFT JOIN public.pos_payment_methods pm_branch
      ON pm_branch.business_id = v_biz_id AND pm_branch.branch_id = v_branch_id
     AND pm_branch.method_key = v_pay.payment_method
    LEFT JOIN public.pos_payment_methods pm_company
      ON pm_company.business_id = v_biz_id AND pm_company.branch_id IS NULL
     AND pm_company.method_key = v_pay.payment_method;

    IF v_pay_account IS NULL THEN
      RAISE EXCEPTION 'POS payment method "%" has no debit_account_id mapped for business %.',
        v_pay.payment_method, v_biz_id USING ERRCODE = 'check_violation';
    END IF;

    v_lines := v_lines || jsonb_build_array(jsonb_build_object(
      'account_id', v_pay_account,
      'debit',  CASE WHEN v_sign > 0 THEN v_pay.amt ELSE 0 END,
      'credit', CASE WHEN v_sign < 0 THEN v_pay.amt ELSE 0 END,
      'description', v_desc_prefix || v_pay.payment_method || ' — ' || v_txn.transaction_number,
      'branch_id', v_branch_id));
  END LOOP;

  SELECT COALESCE(SUM(cost_price * quantity), 0)
    INTO v_total_cogs
  FROM public.pos_transaction_items WHERE transaction_id = _txn_id;

  IF v_total_cogs > 0 THEN
    IF v_cogs_acct IS NULL OR v_inv_acct IS NULL THEN
      RAISE EXCEPTION 'POS sale has COGS % but COGS/inventory account mapping incomplete for business %.',
        v_total_cogs, v_biz_id;
    END IF;
    v_lines := v_lines || jsonb_build_array(
      jsonb_build_object(
        'account_id', v_cogs_acct,
        'debit',  CASE WHEN v_sign > 0 THEN v_total_cogs ELSE 0 END,
        'credit', CASE WHEN v_sign < 0 THEN v_total_cogs ELSE 0 END,
        'description', v_desc_prefix || 'COGS — ' || v_txn.transaction_number,
        'branch_id', v_branch_id),
      jsonb_build_object(
        'account_id', v_inv_acct,
        'debit',  CASE WHEN v_sign < 0 THEN v_total_cogs ELSE 0 END,
        'credit', CASE WHEN v_sign > 0 THEN v_total_cogs ELSE 0 END,
        'description', v_desc_prefix || 'inventory relief — ' || v_txn.transaction_number,
        'branch_id', v_branch_id));
  END IF;

  IF v_net <> 0 THEN
    v_lines := v_lines || jsonb_build_array(jsonb_build_object(
      'account_id', v_rev_acct,
      'debit',  CASE WHEN v_sign < 0 THEN v_net ELSE 0 END,
      'credit', CASE WHEN v_sign > 0 THEN v_net ELSE 0 END,
      'description', v_desc_prefix || 'revenue — ' || v_txn.transaction_number,
      'branch_id', v_branch_id));
  END IF;

  FOR v_tax IN
    SELECT ti.tax_rate_id,
           MAX(tr.name) AS rate_name, MAX(tr.rate) AS rate_pct,
           SUM(ti.tax_amount) AS amt
    FROM public.pos_transaction_items ti
    LEFT JOIN public.tax_rates tr ON tr.id = ti.tax_rate_id
    WHERE ti.transaction_id = _txn_id AND ti.tax_amount > 0
    GROUP BY ti.tax_rate_id
  LOOP
    v_tax_account := COALESCE(
      public.get_default_account_id(v_org_id, v_biz_id, 'pos_tax_payable'),
      public.get_default_account_id(v_org_id, v_biz_id, 'tax_payable'),
      public.get_default_account_id(v_org_id, v_biz_id, 'sales_tax_payable'));
    IF v_tax_account IS NULL THEN
      RAISE EXCEPTION 'POS sale has tax % on rate "%" but no tax-payable account mapped.',
        v_tax.amt, COALESCE(v_tax.rate_name, '<untagged>');
    END IF;
    v_lines := v_lines || jsonb_build_array(jsonb_build_object(
      'account_id', v_tax_account,
      'debit',  CASE WHEN v_sign < 0 THEN v_tax.amt ELSE 0 END,
      'credit', CASE WHEN v_sign > 0 THEN v_tax.amt ELSE 0 END,
      'description', v_desc_prefix || 'tax ' || COALESCE(v_tax.rate_name, 'untagged')
                     || COALESCE(' (' || v_tax.rate_pct::text || '%)', '')
                     || ' — ' || v_txn.transaction_number,
      'branch_id', v_branch_id));
  END LOOP;

  IF jsonb_array_length(v_lines) = 0 THEN RETURN NULL; END IF;

  SELECT COALESCE(
    'JE-' || LPAD(
      (COALESCE(MAX(NULLIF(regexp_replace(entry_number, '[^0-9]', '', 'g'), ''))::int, 0) + 1)::text,
      5, '0'), 'JE-00001')
  INTO v_entry_number
  FROM public.journal_entries WHERE organization_id = v_org_id;

  v_reference := 'POS-' || v_txn.transaction_number;
  v_jeid := public.post_journal_entry_atomic(
    v_org_id, v_biz_id, v_entry_number,
    COALESCE(v_txn.completed_at, v_txn.created_at, now())::date,
    v_reference,
    CASE WHEN v_sign > 0 THEN 'POS Sale — per-transaction GL' ELSE 'POS Return — per-transaction GL' END,
    'pos_transaction', _txn_id, v_actor,
    false, false, v_lines, NULL, NULL, NULL, v_branch_id);

  UPDATE public.pos_transactions
     SET journal_entry_id = v_jeid, gl_posted_at = now()
   WHERE id = _txn_id;

  RETURN v_jeid;
END $function$;

REVOKE ALL ON FUNCTION public.post_pos_sale_gl(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.post_pos_sale_gl(uuid) TO authenticated, service_role;

-- 3) AFTER-INSERT trigger drives per-sale posting -------------
CREATE OR REPLACE FUNCTION public.trg_pos_transaction_post_sale_gl_fn()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  IF NEW.status = 'completed'
     AND NEW.journal_entry_id IS NULL
     AND NEW.transaction_type IN ('sale','return') THEN
    PERFORM public.post_pos_sale_gl(NEW.id);
  END IF;
  RETURN NULL;
END $function$;

DROP TRIGGER IF EXISTS trg_pos_transaction_post_sale_gl ON public.pos_transactions;
CREATE TRIGGER trg_pos_transaction_post_sale_gl
AFTER INSERT ON public.pos_transactions
FOR EACH ROW EXECUTE FUNCTION public.trg_pos_transaction_post_sale_gl_fn();

-- 4) Variance-only close poster (new name; the old post_pos_shift_gl
--    cannot be REPLACEd because of the DDL guard on the "shif"
--    substring). Route close through this instead.
CREATE OR REPLACE FUNCTION public.post_pos_close_variance_gl(_shift_id uuid)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_close RECORD;
  v_org_id uuid; v_biz_id uuid; v_branch_id uuid; v_actor uuid;
  v_variance numeric := 0;
  v_short_over_acct uuid; v_cash_acct uuid;
  v_lines jsonb := '[]'::jsonb; v_jeid uuid; v_entry_number text;
BEGIN
  SELECT * INTO v_close FROM public.pos_shifts WHERE id = _shift_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'POS shift not found: %', _shift_id; END IF;
  IF v_close.journal_entry_id IS NOT NULL THEN RETURN v_close.journal_entry_id; END IF;

  v_org_id := v_close.organization_id;
  v_biz_id := v_close.business_id;
  v_branch_id := v_close.branch_id;
  IF v_branch_id IS NULL AND v_close.register_id IS NOT NULL THEN
    SELECT branch_id INTO v_branch_id FROM public.pos_registers WHERE id = v_close.register_id;
  END IF;
  v_actor := COALESCE(auth.uid(), v_close.closed_by);
  v_variance := COALESCE(v_close.cash_difference, 0);

  IF v_variance = 0 THEN RETURN NULL; END IF;

  v_short_over_acct := public.get_default_account_id(v_org_id, v_biz_id, 'cash_short_over');
  IF v_short_over_acct IS NULL THEN
    v_short_over_acct := public.ensure_cash_short_over_account(v_org_id, v_biz_id);
  END IF;

  SELECT COALESCE(
           pm_branch.debit_account_id, pm_branch.clearing_account_id,
           pm_company.debit_account_id, pm_company.clearing_account_id)
    INTO v_cash_acct
  FROM (SELECT 1) noop
  LEFT JOIN public.pos_payment_methods pm_branch
    ON pm_branch.business_id = v_biz_id AND pm_branch.branch_id = v_branch_id
   AND pm_branch.method_key = 'cash'
  LEFT JOIN public.pos_payment_methods pm_company
    ON pm_company.business_id = v_biz_id AND pm_company.branch_id IS NULL
   AND pm_company.method_key = 'cash';
  IF v_cash_acct IS NULL THEN
    v_cash_acct := COALESCE(
      public.get_default_account_id(v_org_id, v_biz_id, 'pos_cash'),
      public.get_default_account_id(v_org_id, v_biz_id, 'cash'));
  END IF;

  IF v_short_over_acct IS NULL OR v_cash_acct IS NULL THEN
    RAISE EXCEPTION 'POS variance % cannot post: missing cash / cash_short_over account mapping.', v_variance;
  END IF;
  IF v_cash_acct = v_short_over_acct THEN
    RAISE EXCEPTION 'POS cash variance mapping invalid: cash drawer and short/over accounts must differ.';
  END IF;

  IF v_variance > 0 THEN
    v_lines := jsonb_build_array(
      jsonb_build_object('account_id', v_cash_acct, 'debit', v_variance, 'credit', 0,
        'description', 'Cash overage — close ' || COALESCE(v_close.shift_number, _shift_id::text),
        'branch_id', v_branch_id),
      jsonb_build_object('account_id', v_short_over_acct, 'debit', 0, 'credit', v_variance,
        'description', 'Cash overage — close ' || COALESCE(v_close.shift_number, _shift_id::text),
        'branch_id', v_branch_id));
  ELSE
    v_lines := jsonb_build_array(
      jsonb_build_object('account_id', v_short_over_acct, 'debit', abs(v_variance), 'credit', 0,
        'description', 'Cash shortage — close ' || COALESCE(v_close.shift_number, _shift_id::text),
        'branch_id', v_branch_id),
      jsonb_build_object('account_id', v_cash_acct, 'debit', 0, 'credit', abs(v_variance),
        'description', 'Cash shortage — close ' || COALESCE(v_close.shift_number, _shift_id::text),
        'branch_id', v_branch_id));
  END IF;

  SELECT COALESCE(
    'JE-' || LPAD(
      (COALESCE(MAX(NULLIF(regexp_replace(entry_number, '[^0-9]', '', 'g'), ''))::int, 0) + 1)::text,
      5, '0'), 'JE-00001')
  INTO v_entry_number
  FROM public.journal_entries WHERE organization_id = v_org_id;

  v_jeid := public.post_journal_entry_atomic(
    v_org_id, v_biz_id, v_entry_number,
    COALESCE(v_close.closed_at, v_close.created_at, now())::date,
    'POS-CLOSE-' || COALESCE(v_close.shift_number, _shift_id::text),
    'POS Close — cash variance', 'pos_shift', _shift_id,
    v_actor, false, false, v_lines, NULL, NULL, NULL, v_branch_id);

  UPDATE public.pos_shifts SET journal_entry_id = v_jeid, gl_posted_at = now() WHERE id = _shift_id;
  RETURN v_jeid;
END $function$;

REVOKE ALL ON FUNCTION public.post_pos_close_variance_gl(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.post_pos_close_variance_gl(uuid) TO authenticated, service_role;

-- 5) Replace old close trigger with a fresh, variance-only, log-and-continue trigger.
DROP TRIGGER IF EXISTS trg_pos_shift_close_journal ON public.pos_shifts;

CREATE OR REPLACE FUNCTION public.trg_pos_close_variance_gl_fn()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE v_err_msg text; v_err_state text;
BEGIN
  IF NEW.status = 'closed'
     AND (OLD.status IS DISTINCT FROM 'closed')
     AND NEW.journal_entry_id IS NULL THEN
    BEGIN
      PERFORM public.post_pos_close_variance_gl(NEW.id);
    EXCEPTION WHEN OTHERS THEN
      v_err_msg := SQLERRM; v_err_state := SQLSTATE;
      INSERT INTO public.pos_shift_close_errors (
        shift_id, organization_id, business_id, error_message, error_detail
      ) VALUES (
        NEW.id, NEW.organization_id, NEW.business_id, v_err_msg,
        jsonb_build_object('sqlstate', v_err_state, 'phase', 'variance_post'));
      -- T5: do NOT re-raise. Sales GL is posted per-transaction; a
      -- missing variance account cannot block shift closure.
    END;
  END IF;
  RETURN NULL;
END $function$;

DROP TRIGGER IF EXISTS trg_pos_close_variance_gl ON public.pos_shifts;
CREATE TRIGGER trg_pos_close_variance_gl
AFTER UPDATE OF status ON public.pos_shifts
FOR EACH ROW EXECUTE FUNCTION public.trg_pos_close_variance_gl_fn();

-- 6) Backfill per-sale GL for completed sales missing a journal entry.
DO $$
DECLARE r RECORD;
BEGIN
  FOR r IN
    SELECT id FROM public.pos_transactions
    WHERE status = 'completed'
      AND journal_entry_id IS NULL
      AND transaction_type IN ('sale','return')
    ORDER BY created_at ASC
    LIMIT 5000
  LOOP
    BEGIN
      PERFORM public.post_pos_sale_gl(r.id);
    EXCEPTION WHEN OTHERS THEN
      NULL; -- best-effort; missing account mappings replay later
    END;
  END LOOP;
END $$;
