
-- =====================================================================
-- PHASE B — POS Accounting Hardening (Odoo-grade) — final
-- =====================================================================

-- B0. Backfill cost_price on existing POS items from product cost
UPDATE public.pos_transaction_items ti
SET cost_price = COALESCE(p.cost_price, 0)
FROM public.products p
WHERE ti.product_id = p.id
  AND ti.cost_price IS NULL;

UPDATE public.pos_transaction_items
SET cost_price = 0
WHERE cost_price IS NULL;

ALTER TABLE public.pos_transaction_items
  ALTER COLUMN cost_price SET NOT NULL,
  ALTER COLUMN cost_price SET DEFAULT 0;

CREATE OR REPLACE FUNCTION public.stamp_pos_item_cost_snapshot()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  IF (NEW.cost_price IS NULL OR NEW.cost_price = 0) AND NEW.product_id IS NOT NULL THEN
    SELECT COALESCE(cost_price, 0) INTO NEW.cost_price
    FROM public.products WHERE id = NEW.product_id;
  END IF;
  NEW.cost_price := COALESCE(NEW.cost_price, 0);
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_pos_item_cost_snapshot ON public.pos_transaction_items;
CREATE TRIGGER trg_pos_item_cost_snapshot
  BEFORE INSERT ON public.pos_transaction_items
  FOR EACH ROW EXECUTE FUNCTION public.stamp_pos_item_cost_snapshot();

-- B1. Cash variance enforcement columns on pos_shifts
ALTER TABLE public.pos_shifts
  ADD COLUMN IF NOT EXISTS cash_variance_tolerance numeric NOT NULL DEFAULT 100,
  ADD COLUMN IF NOT EXISTS variance_override_pin_id uuid REFERENCES public.pos_manager_pins(id),
  ADD COLUMN IF NOT EXISTS variance_override_reason text;

COMMENT ON COLUMN public.pos_shifts.cash_variance_tolerance IS
  'Maximum absolute |expected - actual| cash difference (in base currency) allowed at shift close without manager override. Default 100.';

-- B2. Seed cash_short_over default account slot
INSERT INTO public.default_account_settings (organization_id, business_id, setting_key, account_id)
SELECT
  s.organization_id,
  s.business_id,
  'cash_short_over',
  (
    SELECT a.id FROM public.accounts a
     WHERE (a.business_id = s.business_id OR a.business_id IS NULL)
       AND a.organization_id = s.organization_id
       AND a.is_active = true
       AND (
         a.detail_type ILIKE '%other_expense%'
         OR a.detail_type ILIKE '%other_income%'
         OR a.account_type::text ILIKE '%expense%'
       )
     ORDER BY (a.detail_type ILIKE '%other_expense%') DESC, a.created_at ASC
     LIMIT 1
  )
FROM public.default_account_settings s
WHERE s.setting_key = 'pos_revenue'
  AND NOT EXISTS (
    SELECT 1 FROM public.default_account_settings s2
     WHERE s2.organization_id = s.organization_id
       AND COALESCE(s2.business_id, '00000000-0000-0000-0000-000000000000'::uuid)
         = COALESCE(s.business_id, '00000000-0000-0000-0000-000000000000'::uuid)
       AND s2.setting_key = 'cash_short_over'
  )
  AND (
    SELECT a.id FROM public.accounts a
     WHERE (a.business_id = s.business_id OR a.business_id IS NULL)
       AND a.organization_id = s.organization_id
       AND a.is_active = true
       AND (
         a.detail_type ILIKE '%other_expense%'
         OR a.detail_type ILIKE '%other_income%'
         OR a.account_type::text ILIKE '%expense%'
       )
     LIMIT 1
  ) IS NOT NULL;

-- B3. Cash variance enforcement trigger
CREATE OR REPLACE FUNCTION public.enforce_pos_shift_cash_variance()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_diff numeric;
BEGIN
  IF NEW.status <> 'closed' OR OLD.status = 'closed' THEN
    RETURN NEW;
  END IF;

  IF NEW.actual_cash IS NULL THEN
    RAISE EXCEPTION 'Cannot close POS shift %: actual_cash counted is required.', NEW.id
      USING ERRCODE = 'check_violation';
  END IF;

  v_diff := COALESCE(NEW.actual_cash, 0) - COALESCE(NEW.expected_cash, 0);
  NEW.cash_difference := v_diff;

  IF abs(v_diff) > COALESCE(NEW.cash_variance_tolerance, 0)
     AND NEW.variance_override_pin_id IS NULL THEN
    RAISE EXCEPTION 'Cash variance % exceeds tolerance % for shift %. Manager override PIN required.',
      v_diff, NEW.cash_variance_tolerance, NEW.id
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_enforce_pos_shift_cash_variance ON public.pos_shifts;
CREATE TRIGGER trg_enforce_pos_shift_cash_variance
  BEFORE UPDATE ON public.pos_shifts
  FOR EACH ROW EXECUTE FUNCTION public.enforce_pos_shift_cash_variance();

-- B4. Rewrite post_pos_shift_gl
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
  v_cogs_account     uuid;
  v_inventory_account uuid;
  v_cash_short_over_account uuid;
  v_total_sales      numeric := 0;
  v_total_tax        numeric := 0;
  v_total_net        numeric := 0;
  v_total_cogs       numeric := 0;
  v_shift_date       date;
  v_reference        text;
  v_lines            jsonb := '[]'::jsonb;
  v_jeid             uuid;
  v_pay              RECORD;
  v_tax              RECORD;
  v_pay_account      uuid;
  v_tax_account      uuid;
  v_variance         numeric := 0;
BEGIN
  SELECT * INTO v_shift FROM public.pos_shifts WHERE id = _shift_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'POS shift not found: %', _shift_id; END IF;

  v_existing := v_shift.journal_entry_id;
  IF v_existing IS NOT NULL THEN RETURN v_existing; END IF;

  v_org_id      := v_shift.organization_id;
  v_business_id := v_shift.business_id;
  v_branch_id   := v_shift.branch_id;
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

  SELECT COALESCE(SUM(total),0), COALESCE(SUM(tax_amount),0), COALESCE(SUM(subtotal),0)
    INTO v_total_sales, v_total_tax, v_total_net
  FROM public.pos_transactions
  WHERE shift_id = _shift_id AND transaction_type='sale' AND status='completed';

  IF v_total_sales = 0 THEN RETURN NULL; END IF;

  SELECT COALESCE(SUM(ti.cost_price * ti.quantity), 0)
    INTO v_total_cogs
  FROM public.pos_transaction_items ti
  JOIN public.pos_transactions t ON t.id = ti.transaction_id
  WHERE t.shift_id = _shift_id
    AND t.transaction_type = 'sale'
    AND t.status = 'completed';

  v_revenue_account  := public.get_default_account_id(v_org_id, v_business_id, 'pos_revenue');
  IF v_revenue_account IS NULL THEN v_revenue_account := public.get_default_account_id(v_org_id, v_business_id, 'sales_revenue'); END IF;

  v_cogs_account     := public.get_default_account_id(v_org_id, v_business_id, 'pos_cogs');
  IF v_cogs_account IS NULL THEN v_cogs_account := public.get_default_account_id(v_org_id, v_business_id, 'cogs'); END IF;

  v_inventory_account := public.get_default_account_id(v_org_id, v_business_id, 'pos_inventory');
  IF v_inventory_account IS NULL THEN v_inventory_account := public.get_default_account_id(v_org_id, v_business_id, 'inventory'); END IF;

  v_cash_short_over_account := public.get_default_account_id(v_org_id, v_business_id, 'cash_short_over');

  IF v_revenue_account IS NULL THEN
    RAISE EXCEPTION 'POS shift cannot post to GL: missing pos_revenue/sales_revenue account mapping. shift_id=%', _shift_id;
  END IF;

  -- DEBITS: per payment method (no silent fallback)
  FOR v_pay IN
    SELECT p.payment_method, SUM(p.amount) AS amt
    FROM public.pos_transaction_payments p
    JOIN public.pos_transactions t ON t.id = p.transaction_id
    WHERE t.shift_id = _shift_id
      AND t.transaction_type = 'sale'
      AND t.status = 'completed'
    GROUP BY p.payment_method
  LOOP
    SELECT COALESCE(pm_branch.debit_account_id, pm_company.debit_account_id)
      INTO v_pay_account
    FROM (SELECT 1) noop
    LEFT JOIN public.pos_payment_methods pm_branch
      ON pm_branch.business_id = v_business_id
     AND pm_branch.branch_id   = v_branch_id
     AND pm_branch.method_key  = v_pay.payment_method
    LEFT JOIN public.pos_payment_methods pm_company
      ON pm_company.business_id = v_business_id
     AND pm_company.branch_id   IS NULL
     AND pm_company.method_key  = v_pay.payment_method;

    IF v_pay_account IS NULL THEN
      RAISE EXCEPTION 'POS payment method "%" has no debit_account_id mapped for business %. Configure it in Company Settings → Payment Methods before closing the shift.',
        v_pay.payment_method, v_business_id
        USING ERRCODE = 'check_violation';
    END IF;

    v_lines := v_lines || jsonb_build_array(jsonb_build_object(
      'account_id', v_pay_account,
      'debit',  v_pay.amt,
      'credit', 0,
      'description', 'POS ' || v_pay.payment_method || ' — shift ' || COALESCE(v_shift.shift_number, _shift_id::text),
      'branch_id', v_branch_id
    ));
  END LOOP;

  v_variance := COALESCE(v_shift.cash_difference, 0);
  IF v_variance <> 0 THEN
    IF v_cash_short_over_account IS NULL THEN
      RAISE EXCEPTION 'POS shift has cash variance % but no cash_short_over account is mapped for business %.',
        v_variance, v_business_id;
    END IF;
    IF v_variance > 0 THEN
      v_lines := v_lines || jsonb_build_array(jsonb_build_object(
        'account_id', v_cash_short_over_account,
        'debit',  0,
        'credit', v_variance,
        'description', 'Cash overage — shift ' || COALESCE(v_shift.shift_number, _shift_id::text),
        'branch_id', v_branch_id
      ));
    ELSE
      v_lines := v_lines || jsonb_build_array(jsonb_build_object(
        'account_id', v_cash_short_over_account,
        'debit',  abs(v_variance),
        'credit', 0,
        'description', 'Cash shortage — shift ' || COALESCE(v_shift.shift_number, _shift_id::text),
        'branch_id', v_branch_id
      ));
    END IF;
  END IF;

  IF v_total_cogs > 0 AND v_cogs_account IS NOT NULL AND v_inventory_account IS NOT NULL THEN
    v_lines := v_lines || jsonb_build_array(
      jsonb_build_object(
        'account_id', v_cogs_account,
        'debit',  v_total_cogs,
        'credit', 0,
        'description', 'COGS — shift ' || COALESCE(v_shift.shift_number, _shift_id::text),
        'branch_id', v_branch_id
      ),
      jsonb_build_object(
        'account_id', v_inventory_account,
        'debit',  0,
        'credit', v_total_cogs,
        'description', 'Inventory relief — shift ' || COALESCE(v_shift.shift_number, _shift_id::text),
        'branch_id', v_branch_id
      )
    );
  END IF;

  v_lines := v_lines || jsonb_build_array(jsonb_build_object(
    'account_id', v_revenue_account,
    'debit',  0,
    'credit', v_total_net,
    'description', 'POS revenue — shift ' || COALESCE(v_shift.shift_number, _shift_id::text),
    'branch_id', v_branch_id
  ));

  FOR v_tax IN
    SELECT
      ti.tax_rate_id,
      MAX(tr.name)  AS rate_name,
      MAX(tr.rate)  AS rate_pct,
      SUM(ti.tax_amount) AS amt
    FROM public.pos_transaction_items ti
    JOIN public.pos_transactions t  ON t.id = ti.transaction_id
    LEFT JOIN public.tax_rates tr   ON tr.id = ti.tax_rate_id
    WHERE t.shift_id = _shift_id
      AND t.transaction_type = 'sale'
      AND t.status = 'completed'
      AND ti.tax_amount > 0
    GROUP BY ti.tax_rate_id
  LOOP
    v_tax_account := public.get_default_account_id(v_org_id, v_business_id, 'pos_tax_payable');
    IF v_tax_account IS NULL THEN
      v_tax_account := public.get_default_account_id(v_org_id, v_business_id, 'tax_payable');
    END IF;
    IF v_tax_account IS NULL THEN
      v_tax_account := public.get_default_account_id(v_org_id, v_business_id, 'sales_tax_payable');
    END IF;
    IF v_tax_account IS NULL THEN
      RAISE EXCEPTION 'POS shift has tax of % on rate "%" but no tax-payable account is mapped.',
        v_tax.amt, COALESCE(v_tax.rate_name, '<untagged>');
    END IF;

    v_lines := v_lines || jsonb_build_array(jsonb_build_object(
      'account_id', v_tax_account,
      'debit',  0,
      'credit', v_tax.amt,
      'description', 'Tax — ' || COALESCE(v_tax.rate_name, 'untagged')
                     || COALESCE(' (' || v_tax.rate_pct::text || '%)', '')
                     || ' — shift ' || COALESCE(v_shift.shift_number, _shift_id::text),
      'branch_id', v_branch_id
    ));
  END LOOP;

  v_jeid := public.post_journal_entry_atomic(
    v_org_id, v_business_id, v_shift_date, v_reference,
    'POS shift ' || COALESCE(v_shift.shift_number, _shift_id::text),
    v_lines, 'pos_shift', _shift_id, 'POS',
    NULL, NULL, 'posted', v_actor, NULL, NULL, v_branch_id
  );

  UPDATE public.pos_shifts
  SET journal_entry_id = v_jeid,
      gl_posted_at     = now()
  WHERE id = _shift_id;

  RETURN v_jeid;
END;
$function$;

-- B5. Per-business default-method GL backfill + soft constraint
DO $$
DECLARE
  b_id uuid;
BEGIN
  FOR b_id IN SELECT DISTINCT business_id FROM public.pos_payment_methods WHERE business_id IS NOT NULL
  LOOP
    BEGIN
      PERFORM public.pos_apply_default_method_gl(b_id);
    EXCEPTION WHEN OTHERS THEN
      -- Continue even if a single business has no defaults yet; the
      -- soft constraint below uses NOT VALID so it won't fail the migration.
      NULL;
    END;
  END LOOP;
END$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'pos_payment_methods_enabled_requires_account'
  ) THEN
    ALTER TABLE public.pos_payment_methods
      ADD CONSTRAINT pos_payment_methods_enabled_requires_account
      CHECK (is_enabled = false OR debit_account_id IS NOT NULL) NOT VALID;
  END IF;
END$$;
