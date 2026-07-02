-- =====================================================================
-- POS receipt snapshot v2 + per-business receipt_settings backfill
-- =====================================================================

-- 1. Replace the snapshot builder so item rows carry product_name +
--    tax_rate_name and the schema_version bumps to 2. Old payloads keep
--    working because the TS model accepts either product_name OR description.
CREATE OR REPLACE FUNCTION public._pos_build_receipt_snapshot(p_tx_id uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH tx AS (
    SELECT * FROM public.pos_transactions WHERE id = p_tx_id
  ),
  items AS (
    SELECT jsonb_agg(jsonb_build_object(
      'id', ti.id,
      'product_id', ti.product_id,
      'product_name', COALESCE(NULLIF(p.name, ''), NULLIF(ti.description, ''), 'Item'),
      'description', ti.description,
      'sku', p.sku,
      'quantity', ti.quantity,
      'unit_price', ti.unit_price,
      'discount_type', ti.discount_type,
      'discount_value', ti.discount_value,
      'discount_amount', CASE
        WHEN ti.discount_type = 'percentage' THEN ROUND((ti.unit_price * ti.quantity * COALESCE(ti.discount_value,0) / 100.0)::numeric, 2)
        WHEN ti.discount_type = 'fixed' THEN COALESCE(ti.discount_value, 0)
        ELSE 0
      END,
      'tax_rate', ti.tax_rate,
      'tax_rate_name', tr.name,
      'tax_amount', ti.tax_amount,
      'line_total', ti.line_total,
      'sort_order', ti.sort_order,
      'cost_price', ti.cost_price,
      'etims_tax_code', ti.etims_tax_code
    ) ORDER BY ti.sort_order, ti.id) AS items
    FROM public.pos_transaction_items ti
    LEFT JOIN public.products p ON p.id = ti.product_id
    LEFT JOIN public.tax_rates tr ON tr.id = ti.tax_rate_id
    WHERE ti.transaction_id = p_tx_id
  ),
  payments AS (
    SELECT jsonb_agg(jsonb_build_object(
      'id', tp.id,
      'payment_method', tp.payment_method,
      'amount', tp.amount,
      'reference', tp.reference,
      'created_at', tp.created_at
    ) ORDER BY tp.created_at) AS payments
    FROM public.pos_transaction_payments tp
    WHERE tp.transaction_id = p_tx_id
  ),
  business AS (
    SELECT to_jsonb(b.*) AS business, b.receipt_settings AS biz_receipt_settings
    FROM tx JOIN public.businesses b ON b.id = tx.business_id
  ),
  branch AS (
    SELECT to_jsonb(br.*) AS branch
    FROM tx LEFT JOIN public.branches br ON br.id = tx.branch_id
  ),
  org AS (
    SELECT to_jsonb(o.*) AS organization
    FROM tx JOIN public.organizations o ON o.id = tx.organization_id
  ),
  customer AS (
    SELECT to_jsonb(c.*) AS customer
    FROM tx LEFT JOIN public.contacts c ON c.id = tx.customer_id
  ),
  cashier AS (
    SELECT jsonb_build_object(
      'id', tx.cashier_id,
      'name', p.full_name,
      'email', p.email
    ) AS cashier
    FROM tx LEFT JOIN public.profiles p ON p.id = tx.cashier_id
  ),
  register AS (
    SELECT to_jsonb(r.*) AS register
    FROM tx LEFT JOIN public.pos_registers r ON r.id = tx.register_id
  ),
  reg_settings AS (
    SELECT ps.setting_value AS register_receipt_settings
    FROM tx
    LEFT JOIN public.pos_settings ps
      ON ps.register_id = tx.register_id
     AND ps.setting_key = 'receipt_settings'
    LIMIT 1
  )
  SELECT jsonb_build_object(
    'schema_version', 2,
    'transaction', to_jsonb(tx.*),
    'items',       COALESCE(items.items, '[]'::jsonb),
    'payments',    COALESCE(payments.payments, '[]'::jsonb),
    'business',    business.business,
    'branch',      branch.branch,
    'organization', org.organization,
    'customer',    customer.customer,
    'cashier',     cashier.cashier,
    'register',    register.register,
    'business_receipt_settings', business.biz_receipt_settings,
    'register_receipt_settings', reg_settings.register_receipt_settings
  )
  FROM tx, items, payments, business, branch, org, customer, cashier, register, reg_settings;
$$;

-- 2. Default receipt-settings JSON (mirrors DEFAULT_EXTENDED_RECEIPT_SETTINGS).
CREATE OR REPLACE FUNCTION public._default_receipt_settings()
RETURNS jsonb
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT jsonb_build_object(
    'paper_size', '80mm',
    'template', 'standard',
    'font_size', 'medium',
    'line_spacing', 'normal',
    'show_logo', true,
    'logo_size', 'medium',
    'primary_color', '#10b981',
    'receipt_header', '',
    'show_store_name', true,
    'show_store_address', true,
    'show_store_phone', true,
    'show_store_email', false,
    'show_receipt_number', true,
    'show_date_time', true,
    'show_cashier_name', true,
    'cashier_label_format', 'cashier',
    'show_register_id', false,
    'show_customer_name', true,
    'show_item_sku', false,
    'show_item_quantity', true,
    'show_unit_price', true,
    'show_item_discount', true,
    'truncate_long_names', true,
    'max_item_name_length', 28,
    'item_display_format', 'single-line',
    'show_subtotal', true,
    'show_discount_total', true,
    'show_tax_breakdown', true,
    'show_tax_rate', false,
    'show_savings', true,
    'show_payment_method', true,
    'show_amount_tendered', true,
    'show_change_due', true,
    'receipt_footer', 'Thank you for your purchase!',
    'show_return_policy', false,
    'return_policy_text', '',
    'show_barcode', false,
    'show_qr_code', false,
    'show_etims_info', true,
    'show_etims_qr', true,
    'auto_print_receipt', true
  )
$$;

-- 3. Backfill businesses with no receipt_settings, preferring legacy
--    organization_settings.receipt_settings of their workspace when present.
DO $$
DECLARE
  v_has_legacy boolean;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public'
      AND table_name='organization_settings'
      AND column_name='receipt_settings'
  ) INTO v_has_legacy;

  IF v_has_legacy THEN
    UPDATE public.businesses b
       SET receipt_settings = COALESCE(os.receipt_settings, public._default_receipt_settings())
      FROM public.organization_settings os
     WHERE os.organization_id = b.organization_id
       AND (b.receipt_settings IS NULL OR b.receipt_settings = '{}'::jsonb);
  END IF;
END $$;

UPDATE public.businesses
   SET receipt_settings = public._default_receipt_settings()
 WHERE receipt_settings IS NULL OR receipt_settings = '{}'::jsonb;

-- 4. Seed default on new businesses going forward.
CREATE OR REPLACE FUNCTION public._seed_business_receipt_settings()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.receipt_settings IS NULL OR NEW.receipt_settings = '{}'::jsonb THEN
    NEW.receipt_settings := public._default_receipt_settings();
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_seed_business_receipt_settings ON public.businesses;
CREATE TRIGGER trg_seed_business_receipt_settings
  BEFORE INSERT ON public.businesses
  FOR EACH ROW
  EXECUTE FUNCTION public._seed_business_receipt_settings();