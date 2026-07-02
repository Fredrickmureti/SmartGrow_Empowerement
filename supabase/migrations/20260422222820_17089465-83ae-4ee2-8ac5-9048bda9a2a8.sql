-- ============================================================================
-- POS Hardening Stage 3
-- ----------------------------------------------------------------------------
-- 1. Replace legacy is_org_member / org-only RLS on 11 POS-related tables
--    with v2 business-scoped + module-permission policies (Issue #1).
-- 2. Drop unsafe `Subscription active check for insert` policies on
--    pos_sessions / pos_transactions (Issue #2).
-- 3. Add per-payment-method GL routing columns (Issues #4, #6).
-- 4. Rewrite post_pos_shift_gl: per-method routing + COGS leg (Issues #4, #5).
-- 5. Rewrite get_pos_z_report tax_summary aggregation (Issue #3).
-- 6. Tighten warehouses_select_v2 with branch gate (Issue #8).
-- 7. Add tax_snapshot column to offline replay rows (Issue #7).
-- 8. Add ensure_pos_ready_for_branch RPC.
-- ============================================================================

-- ---------- 1. POS table RLS hardening ----------

-- pos_payment_methods
DROP POLICY IF EXISTS "Users can view their organization's payment methods" ON public.pos_payment_methods;
DROP POLICY IF EXISTS "Users can manage their organization's payment methods" ON public.pos_payment_methods;
CREATE POLICY pos_payment_methods_select_v2 ON public.pos_payment_methods FOR SELECT
  USING (user_can_access_business(auth.uid(), business_id)
         AND user_has_module_permission(auth.uid(), organization_id, business_id, 'pos', 'read')
         AND (branch_id IS NULL OR can_access_branch(auth.uid(), branch_id)));
CREATE POLICY pos_payment_methods_insert_v2 ON public.pos_payment_methods FOR INSERT
  WITH CHECK (user_can_access_business(auth.uid(), business_id)
              AND user_has_module_permission(auth.uid(), organization_id, business_id, 'pos', 'create'));
CREATE POLICY pos_payment_methods_update_v2 ON public.pos_payment_methods FOR UPDATE
  USING (user_can_access_business(auth.uid(), business_id)
         AND user_has_module_permission(auth.uid(), organization_id, business_id, 'pos', 'write'))
  WITH CHECK (user_can_access_business(auth.uid(), business_id)
              AND user_has_module_permission(auth.uid(), organization_id, business_id, 'pos', 'write'));
CREATE POLICY pos_payment_methods_delete_v2 ON public.pos_payment_methods FOR DELETE
  USING (user_can_access_business(auth.uid(), business_id)
         AND user_has_module_permission(auth.uid(), organization_id, business_id, 'pos', 'delete'));

-- pos_settings
DROP POLICY IF EXISTS "Users can view their organization's POS settings" ON public.pos_settings;
DROP POLICY IF EXISTS "Users can manage their organization's POS settings" ON public.pos_settings;
CREATE POLICY pos_settings_select_v2 ON public.pos_settings FOR SELECT
  USING (user_can_access_business(auth.uid(), business_id)
         AND user_has_module_permission(auth.uid(), organization_id, business_id, 'pos', 'read')
         AND (branch_id IS NULL OR can_access_branch(auth.uid(), branch_id)));
CREATE POLICY pos_settings_insert_v2 ON public.pos_settings FOR INSERT
  WITH CHECK (user_can_access_business(auth.uid(), business_id)
              AND user_has_module_permission(auth.uid(), organization_id, business_id, 'pos', 'create'));
CREATE POLICY pos_settings_update_v2 ON public.pos_settings FOR UPDATE
  USING (user_can_access_business(auth.uid(), business_id)
         AND user_has_module_permission(auth.uid(), organization_id, business_id, 'pos', 'write'))
  WITH CHECK (user_can_access_business(auth.uid(), business_id)
              AND user_has_module_permission(auth.uid(), organization_id, business_id, 'pos', 'write'));
CREATE POLICY pos_settings_delete_v2 ON public.pos_settings FOR DELETE
  USING (user_can_access_business(auth.uid(), business_id)
         AND user_has_module_permission(auth.uid(), organization_id, business_id, 'pos', 'delete'));

-- pos_security_settings
DROP POLICY IF EXISTS "Users can view security settings in their organization" ON public.pos_security_settings;
DROP POLICY IF EXISTS "Managers can manage security settings" ON public.pos_security_settings;
CREATE POLICY pos_security_settings_select_v2 ON public.pos_security_settings FOR SELECT
  USING (user_can_access_business(auth.uid(), business_id)
         AND user_has_module_permission(auth.uid(), organization_id, business_id, 'pos', 'read')
         AND (branch_id IS NULL OR can_access_branch(auth.uid(), branch_id)));
CREATE POLICY pos_security_settings_insert_v2 ON public.pos_security_settings FOR INSERT
  WITH CHECK (user_can_access_business(auth.uid(), business_id)
              AND (has_role(auth.uid(), organization_id, 'owner'::app_role)
                   OR has_role(auth.uid(), organization_id, 'admin'::app_role)
                   OR has_role(auth.uid(), organization_id, 'super_admin'::app_role)));
CREATE POLICY pos_security_settings_update_v2 ON public.pos_security_settings FOR UPDATE
  USING (user_can_access_business(auth.uid(), business_id)
         AND (has_role(auth.uid(), organization_id, 'owner'::app_role)
              OR has_role(auth.uid(), organization_id, 'admin'::app_role)
              OR has_role(auth.uid(), organization_id, 'super_admin'::app_role)))
  WITH CHECK (user_can_access_business(auth.uid(), business_id));
CREATE POLICY pos_security_settings_delete_v2 ON public.pos_security_settings FOR DELETE
  USING (user_can_access_business(auth.uid(), business_id)
         AND (has_role(auth.uid(), organization_id, 'owner'::app_role)
              OR has_role(auth.uid(), organization_id, 'admin'::app_role)
              OR has_role(auth.uid(), organization_id, 'super_admin'::app_role)));

-- pos_gl_mappings
DROP POLICY IF EXISTS "Users can view GL mappings in their organization" ON public.pos_gl_mappings;
DROP POLICY IF EXISTS "Users can manage GL mappings in their organization" ON public.pos_gl_mappings;
CREATE POLICY pos_gl_mappings_select_v2 ON public.pos_gl_mappings FOR SELECT
  USING (user_can_access_business(auth.uid(), business_id)
         AND user_has_module_permission(auth.uid(), organization_id, business_id, 'pos', 'read'));
CREATE POLICY pos_gl_mappings_insert_v2 ON public.pos_gl_mappings FOR INSERT
  WITH CHECK (user_can_access_business(auth.uid(), business_id)
              AND user_has_module_permission(auth.uid(), organization_id, business_id, 'pos', 'create'));
CREATE POLICY pos_gl_mappings_update_v2 ON public.pos_gl_mappings FOR UPDATE
  USING (user_can_access_business(auth.uid(), business_id)
         AND user_has_module_permission(auth.uid(), organization_id, business_id, 'pos', 'write'))
  WITH CHECK (user_can_access_business(auth.uid(), business_id));
CREATE POLICY pos_gl_mappings_delete_v2 ON public.pos_gl_mappings FOR DELETE
  USING (user_can_access_business(auth.uid(), business_id)
         AND user_has_module_permission(auth.uid(), organization_id, business_id, 'pos', 'delete'));

-- pos_held_transactions
DROP POLICY IF EXISTS "Users can view held transactions in their organization" ON public.pos_held_transactions;
DROP POLICY IF EXISTS "Users can manage held transactions in their organization" ON public.pos_held_transactions;
CREATE POLICY pos_held_transactions_select_v2 ON public.pos_held_transactions FOR SELECT
  USING (user_can_access_business(auth.uid(), business_id)
         AND user_has_module_permission(auth.uid(), organization_id, business_id, 'pos', 'read')
         AND (branch_id IS NULL OR can_access_branch(auth.uid(), branch_id)));
CREATE POLICY pos_held_transactions_insert_v2 ON public.pos_held_transactions FOR INSERT
  WITH CHECK (user_can_access_business(auth.uid(), business_id)
              AND user_has_module_permission(auth.uid(), organization_id, business_id, 'pos', 'create'));
CREATE POLICY pos_held_transactions_update_v2 ON public.pos_held_transactions FOR UPDATE
  USING (user_can_access_business(auth.uid(), business_id)
         AND user_has_module_permission(auth.uid(), organization_id, business_id, 'pos', 'write'))
  WITH CHECK (user_can_access_business(auth.uid(), business_id));
CREATE POLICY pos_held_transactions_delete_v2 ON public.pos_held_transactions FOR DELETE
  USING (user_can_access_business(auth.uid(), business_id)
         AND user_has_module_permission(auth.uid(), organization_id, business_id, 'pos', 'delete'));

-- pos_cashiers — drop legacy 4-arg perm policies, replace with 5-arg business-scoped
DROP POLICY IF EXISTS pos_cashiers_select_perm ON public.pos_cashiers;
DROP POLICY IF EXISTS pos_cashiers_insert_perm ON public.pos_cashiers;
DROP POLICY IF EXISTS pos_cashiers_update_perm ON public.pos_cashiers;
DROP POLICY IF EXISTS pos_cashiers_delete_perm ON public.pos_cashiers;
CREATE POLICY pos_cashiers_select_v2 ON public.pos_cashiers FOR SELECT
  USING (user_can_access_business(auth.uid(), business_id)
         AND user_has_module_permission(auth.uid(), organization_id, business_id, 'pos', 'read')
         AND (branch_id IS NULL OR can_access_branch(auth.uid(), branch_id)));
CREATE POLICY pos_cashiers_insert_v2 ON public.pos_cashiers FOR INSERT
  WITH CHECK (user_can_access_business(auth.uid(), business_id)
              AND user_has_module_permission(auth.uid(), organization_id, business_id, 'pos', 'create'));
CREATE POLICY pos_cashiers_update_v2 ON public.pos_cashiers FOR UPDATE
  USING (user_can_access_business(auth.uid(), business_id)
         AND user_has_module_permission(auth.uid(), organization_id, business_id, 'pos', 'write'))
  WITH CHECK (user_can_access_business(auth.uid(), business_id));
CREATE POLICY pos_cashiers_delete_v2 ON public.pos_cashiers FOR DELETE
  USING (user_can_access_business(auth.uid(), business_id)
         AND user_has_module_permission(auth.uid(), organization_id, business_id, 'pos', 'delete'));

-- pos_cash_movements — drop legacy 4-arg perm policies
DROP POLICY IF EXISTS pos_cash_select_perm ON public.pos_cash_movements;
DROP POLICY IF EXISTS pos_cash_insert_perm ON public.pos_cash_movements;
DROP POLICY IF EXISTS pos_cash_update_perm ON public.pos_cash_movements;
DROP POLICY IF EXISTS pos_cash_delete_perm ON public.pos_cash_movements;
CREATE POLICY pos_cash_movements_select_v2 ON public.pos_cash_movements FOR SELECT
  USING (user_can_access_business(auth.uid(), business_id)
         AND user_has_module_permission(auth.uid(), organization_id, business_id, 'pos', 'read')
         AND (branch_id IS NULL OR can_access_branch(auth.uid(), branch_id)));
CREATE POLICY pos_cash_movements_insert_v2 ON public.pos_cash_movements FOR INSERT
  WITH CHECK (user_can_access_business(auth.uid(), business_id)
              AND user_has_module_permission(auth.uid(), organization_id, business_id, 'pos', 'create'));
CREATE POLICY pos_cash_movements_update_v2 ON public.pos_cash_movements FOR UPDATE
  USING (user_can_access_business(auth.uid(), business_id)
         AND user_has_module_permission(auth.uid(), organization_id, business_id, 'pos', 'write'))
  WITH CHECK (user_can_access_business(auth.uid(), business_id));
CREATE POLICY pos_cash_movements_delete_v2 ON public.pos_cash_movements FOR DELETE
  USING (user_can_access_business(auth.uid(), business_id)
         AND user_has_module_permission(auth.uid(), organization_id, business_id, 'pos', 'delete'));

-- pos_daily_sales_summary
DROP POLICY IF EXISTS "Users can view their org daily summaries" ON public.pos_daily_sales_summary;
CREATE POLICY pos_daily_sales_summary_select_v2 ON public.pos_daily_sales_summary FOR SELECT
  USING (user_can_access_business(auth.uid(), business_id)
         AND user_has_module_permission(auth.uid(), organization_id, business_id, 'pos', 'read')
         AND (branch_id IS NULL OR can_access_branch(auth.uid(), branch_id)));

-- pos_transaction_items — replace org-member-via-parent with business-scoped via parent
DROP POLICY IF EXISTS "Users can view transaction items via transaction" ON public.pos_transaction_items;
DROP POLICY IF EXISTS "Users can manage transaction items via transaction" ON public.pos_transaction_items;
CREATE POLICY pos_transaction_items_select_v2 ON public.pos_transaction_items FOR SELECT
  USING (EXISTS (
    SELECT 1 FROM public.pos_transactions t
    WHERE t.id = pos_transaction_items.transaction_id
      AND user_can_access_business(auth.uid(), t.business_id)
      AND user_has_module_permission(auth.uid(), t.organization_id, t.business_id, 'pos', 'read')
      AND (t.branch_id IS NULL OR can_access_branch(auth.uid(), t.branch_id))
  ));
CREATE POLICY pos_transaction_items_insert_v2 ON public.pos_transaction_items FOR INSERT
  WITH CHECK (EXISTS (
    SELECT 1 FROM public.pos_transactions t
    WHERE t.id = pos_transaction_items.transaction_id
      AND user_can_access_business(auth.uid(), t.business_id)
      AND user_has_module_permission(auth.uid(), t.organization_id, t.business_id, 'pos', 'create')
  ));
CREATE POLICY pos_transaction_items_update_v2 ON public.pos_transaction_items FOR UPDATE
  USING (EXISTS (
    SELECT 1 FROM public.pos_transactions t
    WHERE t.id = pos_transaction_items.transaction_id
      AND user_can_access_business(auth.uid(), t.business_id)
      AND user_has_module_permission(auth.uid(), t.organization_id, t.business_id, 'pos', 'write')
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM public.pos_transactions t
    WHERE t.id = pos_transaction_items.transaction_id
      AND user_can_access_business(auth.uid(), t.business_id)
  ));
CREATE POLICY pos_transaction_items_delete_v2 ON public.pos_transaction_items FOR DELETE
  USING (EXISTS (
    SELECT 1 FROM public.pos_transactions t
    WHERE t.id = pos_transaction_items.transaction_id
      AND user_can_access_business(auth.uid(), t.business_id)
      AND user_has_module_permission(auth.uid(), t.organization_id, t.business_id, 'pos', 'delete')
  ));

-- pos_transaction_payments — same pattern
DROP POLICY IF EXISTS "Users can view transaction payments via transaction" ON public.pos_transaction_payments;
DROP POLICY IF EXISTS "Users can manage transaction payments via transaction" ON public.pos_transaction_payments;
CREATE POLICY pos_transaction_payments_select_v2 ON public.pos_transaction_payments FOR SELECT
  USING (EXISTS (
    SELECT 1 FROM public.pos_transactions t
    WHERE t.id = pos_transaction_payments.transaction_id
      AND user_can_access_business(auth.uid(), t.business_id)
      AND user_has_module_permission(auth.uid(), t.organization_id, t.business_id, 'pos', 'read')
      AND (t.branch_id IS NULL OR can_access_branch(auth.uid(), t.branch_id))
  ));
CREATE POLICY pos_transaction_payments_insert_v2 ON public.pos_transaction_payments FOR INSERT
  WITH CHECK (EXISTS (
    SELECT 1 FROM public.pos_transactions t
    WHERE t.id = pos_transaction_payments.transaction_id
      AND user_can_access_business(auth.uid(), t.business_id)
      AND user_has_module_permission(auth.uid(), t.organization_id, t.business_id, 'pos', 'create')
  ));
CREATE POLICY pos_transaction_payments_update_v2 ON public.pos_transaction_payments FOR UPDATE
  USING (EXISTS (
    SELECT 1 FROM public.pos_transactions t
    WHERE t.id = pos_transaction_payments.transaction_id
      AND user_can_access_business(auth.uid(), t.business_id)
      AND user_has_module_permission(auth.uid(), t.organization_id, t.business_id, 'pos', 'write')
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM public.pos_transactions t
    WHERE t.id = pos_transaction_payments.transaction_id
      AND user_can_access_business(auth.uid(), t.business_id)
  ));
CREATE POLICY pos_transaction_payments_delete_v2 ON public.pos_transaction_payments FOR DELETE
  USING (EXISTS (
    SELECT 1 FROM public.pos_transactions t
    WHERE t.id = pos_transaction_payments.transaction_id
      AND user_can_access_business(auth.uid(), t.business_id)
      AND user_has_module_permission(auth.uid(), t.organization_id, t.business_id, 'pos', 'delete')
  ));

-- stock_movements — replace org-only with business-scoped via inventory module perms
DROP POLICY IF EXISTS "Users can view stock movements in their organizations" ON public.stock_movements;
DROP POLICY IF EXISTS "Users can create stock movements in their organizations" ON public.stock_movements;
DROP POLICY IF EXISTS "Users can update stock movements in their organizations" ON public.stock_movements;
DROP POLICY IF EXISTS "Users can delete stock movements in their organizations" ON public.stock_movements;
CREATE POLICY stock_movements_select_v2 ON public.stock_movements FOR SELECT
  USING (
    business_id IS NULL  -- legacy rows pre-business stamp
    OR (user_can_access_business(auth.uid(), business_id)
        AND user_has_module_permission(auth.uid(), organization_id, business_id, 'products', 'read'))
  );
CREATE POLICY stock_movements_insert_v2 ON public.stock_movements FOR INSERT
  WITH CHECK (
    business_id IS NULL
    OR (user_can_access_business(auth.uid(), business_id)
        AND user_has_module_permission(auth.uid(), organization_id, business_id, 'products', 'create'))
  );
CREATE POLICY stock_movements_update_v2 ON public.stock_movements FOR UPDATE
  USING (
    business_id IS NULL
    OR (user_can_access_business(auth.uid(), business_id)
        AND user_has_module_permission(auth.uid(), organization_id, business_id, 'products', 'write'))
  )
  WITH CHECK (
    business_id IS NULL
    OR user_can_access_business(auth.uid(), business_id)
  );
CREATE POLICY stock_movements_delete_v2 ON public.stock_movements FOR DELETE
  USING (
    business_id IS NULL
    OR (user_can_access_business(auth.uid(), business_id)
        AND user_has_module_permission(auth.uid(), organization_id, business_id, 'products', 'delete'))
  );

-- ---------- 2. Drop legacy "Subscription active check" INSERT policies ----------
-- These had qual=NULL with WITH CHECK that bypassed business scoping (TB-2 hole).
DROP POLICY IF EXISTS "Subscription active check for insert on pos_sessions" ON public.pos_sessions;
DROP POLICY IF EXISTS "Subscription active check for insert on pos_transactions" ON public.pos_transactions;

-- ---------- 3. Add per-payment-method GL routing columns ----------
ALTER TABLE public.pos_payment_methods
  ADD COLUMN IF NOT EXISTS clearing_account_id uuid REFERENCES public.accounts(id);
COMMENT ON COLUMN public.pos_payment_methods.debit_account_id IS
  'Cash/bank account to debit for this payment method (e.g. Cash on Hand for cash, Card Clearing for card). Equivalent to Odoo payment.method.journal.default_account.';
COMMENT ON COLUMN public.pos_payment_methods.clearing_account_id IS
  'Optional separate clearing/undeposited-funds account used for non-cash methods (card, mobile money) before settlement to bank. If NULL, debit_account_id is used directly.';

-- ---------- 4. Rewrite post_pos_shift_gl with per-method routing + COGS ----------
CREATE OR REPLACE FUNCTION public.post_pos_shift_gl(_shift_id uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_shift            RECORD;
  v_existing         uuid;
  v_org_id           uuid;
  v_business_id      uuid;
  v_branch_id        uuid;
  v_actor            uuid;
  v_revenue_account  uuid;
  v_tax_account      uuid;
  v_cogs_account     uuid;
  v_inventory_account uuid;
  v_total_sales      numeric := 0;
  v_total_tax        numeric := 0;
  v_total_net        numeric := 0;
  v_total_cogs       numeric := 0;
  v_shift_date       date;
  v_reference        text;
  v_entry_number     text;
  v_lines            jsonb := '[]'::jsonb;
  v_jeid             uuid;
  v_pay              RECORD;
  v_pay_account      uuid;
  v_pay_total_sum    numeric := 0;
  v_payment_total    numeric := 0;
BEGIN
  SELECT * INTO v_shift FROM public.pos_shifts WHERE id = _shift_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'POS shift not found: %', _shift_id; END IF;

  v_existing := v_shift.journal_entry_id;
  IF v_existing IS NOT NULL THEN RETURN v_existing; END IF;

  v_org_id := v_shift.organization_id;
  v_business_id := v_shift.business_id;
  v_branch_id := v_shift.branch_id;
  IF v_branch_id IS NULL AND v_shift.register_id IS NOT NULL THEN
    SELECT branch_id INTO v_branch_id FROM public.pos_registers WHERE id = v_shift.register_id;
  END IF;

  v_actor := COALESCE(auth.uid(), v_shift.closed_by);
  IF v_actor IS NOT NULL AND v_business_id IS NOT NULL THEN
    IF NOT (
      EXISTS (SELECT 1 FROM public.user_business_access WHERE user_id = v_actor AND business_id = v_business_id)
      OR public.has_role(v_actor, v_org_id, 'owner'::public.app_role)
      OR public.has_role(v_actor, v_org_id, 'admin'::public.app_role)
    ) THEN
      RAISE EXCEPTION 'User % lacks business access to post POS shift GL for business %', v_actor, v_business_id USING ERRCODE = '42501';
    END IF;
  END IF;

  v_shift_date := COALESCE(v_shift.closed_at, v_shift.created_at, now())::date;
  v_reference  := 'POS-SHIFT-' || COALESCE(v_shift.shift_number, _shift_id::text);

  -- Aggregate sale totals
  SELECT COALESCE(SUM(total),0), COALESCE(SUM(tax_amount),0), COALESCE(SUM(subtotal),0)
    INTO v_total_sales, v_total_tax, v_total_net
  FROM public.pos_transactions
  WHERE shift_id = _shift_id AND transaction_type='sale' AND status='completed';

  IF v_total_sales = 0 THEN RETURN NULL; END IF;

  -- COGS aggregate (Issue #5)
  SELECT COALESCE(SUM(ti.cost_price * ti.quantity), 0)
    INTO v_total_cogs
  FROM public.pos_transaction_items ti
  JOIN public.pos_transactions t ON t.id = ti.transaction_id
  WHERE t.shift_id = _shift_id
    AND t.transaction_type = 'sale'
    AND t.status = 'completed'
    AND ti.cost_price IS NOT NULL;

  -- Resolve revenue / tax / cogs / inventory accounts
  v_revenue_account := public.get_default_account_id(v_org_id, v_business_id, 'pos_revenue');
  IF v_revenue_account IS NULL THEN v_revenue_account := public.get_default_account_id(v_org_id, v_business_id, 'sales_revenue'); END IF;

  v_tax_account := public.get_default_account_id(v_org_id, v_business_id, 'pos_tax_payable');
  IF v_tax_account IS NULL THEN v_tax_account := public.get_default_account_id(v_org_id, v_business_id, 'tax_payable'); END IF;
  IF v_tax_account IS NULL THEN v_tax_account := public.get_default_account_id(v_org_id, v_business_id, 'sales_tax_payable'); END IF;

  v_cogs_account := public.get_default_account_id(v_org_id, v_business_id, 'pos_cogs');
  IF v_cogs_account IS NULL THEN v_cogs_account := public.get_default_account_id(v_org_id, v_business_id, 'cogs'); END IF;

  v_inventory_account := public.get_default_account_id(v_org_id, v_business_id, 'pos_inventory');
  IF v_inventory_account IS NULL THEN v_inventory_account := public.get_default_account_id(v_org_id, v_business_id, 'inventory'); END IF;

  IF v_revenue_account IS NULL THEN
    RAISE EXCEPTION 'POS shift cannot post to GL: missing pos_revenue/sales_revenue account mapping. shift_id=%', _shift_id;
  END IF;
  IF v_total_tax > 0 AND v_tax_account IS NULL THEN
    RAISE EXCEPTION 'POS shift has tax of % but no tax-payable account is mapped.', v_total_tax;
  END IF;

  -- Per-payment-method debit lines (Issue #4)
  -- Sum payments from this shift, group by payment_method, route via pos_payment_methods.
  FOR v_pay IN
    SELECT p.payment_method, SUM(p.amount) AS amt
    FROM public.pos_transaction_payments p
    JOIN public.pos_transactions t ON t.id = p.transaction_id
    WHERE t.shift_id = _shift_id
      AND t.transaction_type = 'sale'
      AND t.status = 'completed'
      AND p.status = 'completed'
    GROUP BY p.payment_method
  LOOP
    v_payment_total := v_payment_total + v_pay.amt;

    -- Resolve account for this method: clearing_account preferred for non-cash, else debit_account.
    SELECT CASE WHEN v_pay.payment_method = 'cash' THEN COALESCE(pm.debit_account_id, pm.clearing_account_id)
                ELSE COALESCE(pm.clearing_account_id, pm.debit_account_id)
           END
      INTO v_pay_account
    FROM public.pos_payment_methods pm
    WHERE pm.business_id = v_business_id
      AND pm.method_key = v_pay.payment_method
    ORDER BY (pm.branch_id IS NOT NULL AND pm.branch_id = v_branch_id) DESC NULLS LAST,
             pm.branch_id NULLS LAST
    LIMIT 1;

    -- Fallback to default account settings if no method-specific mapping exists.
    IF v_pay_account IS NULL THEN
      v_pay_account := public.get_default_account_id(v_org_id, v_business_id, 'pos_' || v_pay.payment_method);
    END IF;
    IF v_pay_account IS NULL AND v_pay.payment_method = 'cash' THEN
      v_pay_account := public.get_default_account_id(v_org_id, v_business_id, 'pos_cash');
      IF v_pay_account IS NULL THEN v_pay_account := public.get_default_account_id(v_org_id, v_business_id, 'cash'); END IF;
    END IF;
    IF v_pay_account IS NULL THEN
      RAISE EXCEPTION 'POS shift % has payment method "%" with no GL account mapping. Configure pos_payment_methods.debit_account_id (or clearing_account_id) for this method on business %.',
        _shift_id, v_pay.payment_method, v_business_id;
    END IF;

    v_lines := v_lines || jsonb_build_array(jsonb_build_object(
      'account_id', v_pay_account, 'debit', v_pay.amt, 'credit', 0,
      'description', 'POS Receipts - ' || v_pay.payment_method
    ));
  END LOOP;

  -- If payments don't cover total sales (e.g. credit sales accounted elsewhere), back-fill cash for the gap.
  IF v_payment_total < v_total_sales THEN
    DECLARE v_cash_default uuid;
    BEGIN
      v_cash_default := public.get_default_account_id(v_org_id, v_business_id, 'pos_cash');
      IF v_cash_default IS NULL THEN v_cash_default := public.get_default_account_id(v_org_id, v_business_id, 'cash'); END IF;
      IF v_cash_default IS NULL THEN
        RAISE EXCEPTION 'POS shift % payments (%) less than sales (%) and no fallback cash account configured.', _shift_id, v_payment_total, v_total_sales;
      END IF;
      v_lines := v_lines || jsonb_build_array(jsonb_build_object(
        'account_id', v_cash_default, 'debit', v_total_sales - v_payment_total, 'credit', 0,
        'description', 'POS Receipts - unallocated'
      ));
    END;
  END IF;

  -- Revenue + tax credit lines
  v_lines := v_lines || jsonb_build_array(
    jsonb_build_object('account_id', v_revenue_account, 'debit', 0, 'credit', v_total_net, 'description', 'POS Sales Revenue')
  );
  IF v_total_tax > 0 AND v_tax_account IS NOT NULL THEN
    v_lines := v_lines || jsonb_build_array(
      jsonb_build_object('account_id', v_tax_account, 'debit', 0, 'credit', v_total_tax, 'description', 'POS Sales Tax Collected')
    );
  END IF;

  -- COGS leg (Issue #5) — only if both accounts mapped and we have cost data.
  IF v_total_cogs > 0 THEN
    IF v_cogs_account IS NULL OR v_inventory_account IS NULL THEN
      RAISE EXCEPTION 'POS shift % has COGS of % but missing pos_cogs/cogs or pos_inventory/inventory account mapping for business %.',
        _shift_id, v_total_cogs, v_business_id;
    END IF;
    v_lines := v_lines || jsonb_build_array(
      jsonb_build_object('account_id', v_cogs_account, 'debit', v_total_cogs, 'credit', 0, 'description', 'POS Cost of Goods Sold'),
      jsonb_build_object('account_id', v_inventory_account, 'debit', 0, 'credit', v_total_cogs, 'description', 'POS Inventory Drawdown')
    );
  END IF;

  SELECT COALESCE('JE-' || LPAD((COALESCE(MAX(NULLIF(regexp_replace(entry_number,'[^0-9]','','g'),''))::int,0)+1)::text,5,'0'),'JE-00001')
    INTO v_entry_number FROM public.journal_entries WHERE organization_id = v_org_id;

  v_jeid := public.post_journal_entry_atomic(
    v_org_id, v_business_id, v_entry_number, v_shift_date, v_reference,
    'POS Shift Close - aggregated GL posting','pos_shift', _shift_id, v_shift.closed_by,
    false, false, v_lines, NULL, NULL, 'main', v_branch_id
  );

  BEGIN
    UPDATE public.pos_shifts SET journal_entry_id = v_jeid, gl_posted_at = COALESCE(gl_posted_at, now()) WHERE id = _shift_id;
  EXCEPTION WHEN undefined_column THEN NULL; END;

  RETURN v_jeid;
END
$function$;

-- ---------- 5. Rewrite get_pos_z_report tax_summary ----------
CREATE OR REPLACE FUNCTION public.get_pos_z_report(
  p_organization_id uuid,
  p_business_id uuid,
  p_date date DEFAULT CURRENT_DATE,
  p_register_id uuid DEFAULT NULL::uuid
)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_result            JSONB;
  v_shifts            JSONB;
  v_payment_breakdown JSONB;
  v_tax_summary       JSONB;
  v_totals            JSONB;
BEGIN
  IF p_business_id IS NULL THEN
    RAISE EXCEPTION 'business_id is required for POS Z-Report' USING ERRCODE='invalid_parameter_value';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.businesses WHERE id=p_business_id AND organization_id=p_organization_id) THEN
    RAISE EXCEPTION 'business % does not belong to organization %', p_business_id, p_organization_id USING ERRCODE='insufficient_privilege';
  END IF;
  PERFORM public._pos_assert_business_access(p_organization_id, p_business_id);

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'shift_id',s.id,'shift_number',s.shift_number,'user_id',s.user_id,
    'opened_at',s.opened_at,'closed_at',s.closed_at,'status',s.status,
    'opening_cash',s.opening_cash,'expected_cash',s.expected_cash,
    'actual_cash',s.actual_cash,'cash_difference',s.cash_difference)),'[]'::JSONB) INTO v_shifts
  FROM pos_shifts s
  WHERE s.organization_id=p_organization_id AND s.business_id=p_business_id
    AND DATE(COALESCE(s.closed_at,s.opened_at))=p_date
    AND (p_register_id IS NULL OR s.register_id=p_register_id);

  SELECT jsonb_build_object(
    'total_sales', COALESCE(SUM(CASE WHEN t.transaction_type='sale' AND t.status='completed' THEN t.total ELSE 0 END),0),
    'total_returns', COALESCE(SUM(CASE WHEN t.transaction_type='return' AND t.status='completed' THEN t.total ELSE 0 END),0),
    'total_voids', COALESCE(SUM(CASE WHEN t.status='voided' THEN t.total ELSE 0 END),0),
    'net_sales', COALESCE(SUM(CASE WHEN t.status='completed' AND t.transaction_type='sale' THEN t.total
                                    WHEN t.status='completed' AND t.transaction_type='return' THEN -t.total ELSE 0 END),0),
    'total_tax', COALESCE(SUM(CASE WHEN t.status='completed' THEN t.tax_amount ELSE 0 END),0),
    'total_discounts', COALESCE(SUM(CASE WHEN t.status='completed' THEN t.discount_amount ELSE 0 END),0),
    'transaction_count', COUNT(*) FILTER (WHERE t.status='completed')
  ) INTO v_totals
  FROM pos_transactions t JOIN pos_shifts s ON s.id=t.shift_id
  WHERE s.organization_id=p_organization_id AND s.business_id=p_business_id
    AND DATE(COALESCE(s.closed_at,s.opened_at))=p_date
    AND (p_register_id IS NULL OR s.register_id=p_register_id);

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'payment_method',sub.payment_method,
    'total_amount',sub.total_amount,
    'transaction_count',sub.txn_count
  )),'[]'::JSONB) INTO v_payment_breakdown
  FROM (
    SELECT p.payment_method, SUM(p.amount) AS total_amount, COUNT(DISTINCT p.transaction_id) AS txn_count
    FROM pos_transaction_payments p
    JOIN pos_transactions t ON t.id=p.transaction_id
    JOIN pos_shifts s ON s.id=t.shift_id
    WHERE s.organization_id=p_organization_id AND s.business_id=p_business_id
      AND DATE(COALESCE(s.closed_at,s.opened_at))=p_date
      AND (p_register_id IS NULL OR s.register_id=p_register_id)
      AND t.status='completed' AND p.status='completed'
    GROUP BY p.payment_method
  ) sub;

  -- Tax breakdown (Issue #3) — per tax_rate / tax_rate_id
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'tax_rate', sub.tax_rate,
    'tax_rate_id', sub.tax_rate_id,
    'taxable_amount', sub.taxable_amount,
    'tax_amount', sub.tax_amount,
    'item_count', sub.item_count
  ) ORDER BY sub.tax_rate), '[]'::jsonb) INTO v_tax_summary
  FROM (
    SELECT
      COALESCE(ti.tax_rate, 0) AS tax_rate,
      ti.tax_rate_id AS tax_rate_id,
      SUM(ti.line_total - COALESCE(ti.tax_amount,0)) AS taxable_amount,
      SUM(COALESCE(ti.tax_amount,0)) AS tax_amount,
      COUNT(*) AS item_count
    FROM pos_transaction_items ti
    JOIN pos_transactions t ON t.id = ti.transaction_id
    JOIN pos_shifts s ON s.id = t.shift_id
    WHERE s.organization_id = p_organization_id
      AND s.business_id = p_business_id
      AND DATE(COALESCE(s.closed_at, s.opened_at)) = p_date
      AND (p_register_id IS NULL OR s.register_id = p_register_id)
      AND t.status = 'completed'
      AND t.transaction_type = 'sale'
    GROUP BY COALESCE(ti.tax_rate, 0), ti.tax_rate_id
  ) sub;

  v_result := jsonb_build_object(
    'date', p_date,
    'business_id', p_business_id,
    'register_id', p_register_id,
    'shifts', v_shifts,
    'totals', v_totals,
    'payment_breakdown', v_payment_breakdown,
    'tax_summary', v_tax_summary,
    'generated_at', now()
  );
  RETURN v_result;
END
$function$;

-- ---------- 6. Tighten warehouses_select_v2 with branch gate (Issue #8) ----------
DROP POLICY IF EXISTS warehouses_select_v2 ON public.warehouses;
CREATE POLICY warehouses_select_v2 ON public.warehouses FOR SELECT
  USING (
    user_can_access_business(auth.uid(), business_id)
    AND user_has_module_permission(auth.uid(), organization_id, business_id, 'products', 'read')
    AND (branch_id IS NULL OR can_access_branch(auth.uid(), branch_id))
  );

-- ---------- 7. Add tax_snapshot column to held transactions for offline replay audit ----------
ALTER TABLE public.pos_held_transactions
  ADD COLUMN IF NOT EXISTS tax_snapshot jsonb;
COMMENT ON COLUMN public.pos_held_transactions.tax_snapshot IS
  'Snapshot of tax-rate context (per line: tax_rate_id, rate, name) captured when the cart was held/queued offline. Preserves audit trail if branch tax rates change before replay.';

-- ---------- 8. ensure_pos_ready_for_branch RPC ----------
CREATE OR REPLACE FUNCTION public.ensure_pos_ready_for_branch(
  _business_id uuid,
  _branch_id uuid
)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_missing       text[] := ARRAY[]::text[];
  v_org_id        uuid;
  v_register_cnt  int;
  v_warehouse_cnt int;
  v_payment_cnt   int;
  v_payment_unmapped int;
  v_cashier_cnt   int;
  v_revenue_acct  uuid;
  v_cash_acct     uuid;
  v_tax_acct      uuid;
BEGIN
  IF _business_id IS NULL THEN RETURN jsonb_build_object('ok', false, 'missing', ARRAY['business_id']); END IF;
  IF _branch_id IS NULL THEN RETURN jsonb_build_object('ok', false, 'missing', ARRAY['branch_id']); END IF;

  SELECT organization_id INTO v_org_id FROM public.businesses WHERE id = _business_id;
  IF v_org_id IS NULL THEN RETURN jsonb_build_object('ok', false, 'missing', ARRAY['business_not_found']); END IF;

  SELECT count(*) INTO v_register_cnt
  FROM public.pos_registers
  WHERE business_id = _business_id AND branch_id = _branch_id AND COALESCE(is_active, true) = true;
  IF v_register_cnt = 0 THEN v_missing := array_append(v_missing, 'register'); END IF;

  SELECT count(*) INTO v_warehouse_cnt
  FROM public.warehouses
  WHERE business_id = _business_id AND branch_id = _branch_id AND COALESCE(is_active, true) = true;
  IF v_warehouse_cnt = 0 THEN v_missing := array_append(v_missing, 'warehouse'); END IF;

  SELECT count(*) INTO v_payment_cnt
  FROM public.pos_payment_methods
  WHERE business_id = _business_id
    AND COALESCE(is_enabled, true) = true
    AND (branch_id IS NULL OR branch_id = _branch_id);
  IF v_payment_cnt = 0 THEN v_missing := array_append(v_missing, 'payment_methods'); END IF;

  -- At least one enabled method must have a debit OR clearing account mapped
  SELECT count(*) INTO v_payment_unmapped
  FROM public.pos_payment_methods
  WHERE business_id = _business_id
    AND COALESCE(is_enabled, true) = true
    AND (branch_id IS NULL OR branch_id = _branch_id)
    AND debit_account_id IS NULL
    AND clearing_account_id IS NULL;
  IF v_payment_cnt > 0 AND v_payment_unmapped = v_payment_cnt THEN
    v_missing := array_append(v_missing, 'payment_method_gl_mapping');
  END IF;

  SELECT count(*) INTO v_cashier_cnt
  FROM public.pos_cashiers
  WHERE business_id = _business_id AND branch_id = _branch_id AND COALESCE(is_active, true) = true;
  IF v_cashier_cnt = 0 THEN v_missing := array_append(v_missing, 'cashier'); END IF;

  v_revenue_acct := COALESCE(
    public.get_default_account_id(v_org_id, _business_id, 'pos_revenue'),
    public.get_default_account_id(v_org_id, _business_id, 'sales_revenue')
  );
  IF v_revenue_acct IS NULL THEN v_missing := array_append(v_missing, 'revenue_account'); END IF;

  v_cash_acct := COALESCE(
    public.get_default_account_id(v_org_id, _business_id, 'pos_cash'),
    public.get_default_account_id(v_org_id, _business_id, 'cash')
  );
  IF v_cash_acct IS NULL THEN v_missing := array_append(v_missing, 'cash_account'); END IF;

  v_tax_acct := COALESCE(
    public.get_default_account_id(v_org_id, _business_id, 'pos_tax_payable'),
    public.get_default_account_id(v_org_id, _business_id, 'tax_payable'),
    public.get_default_account_id(v_org_id, _business_id, 'sales_tax_payable')
  );
  IF v_tax_acct IS NULL THEN v_missing := array_append(v_missing, 'tax_account'); END IF;

  RETURN jsonb_build_object(
    'ok', (array_length(v_missing, 1) IS NULL),
    'missing', v_missing,
    'business_id', _business_id,
    'branch_id', _branch_id
  );
END
$function$;

GRANT EXECUTE ON FUNCTION public.ensure_pos_ready_for_branch(uuid, uuid) TO authenticated;