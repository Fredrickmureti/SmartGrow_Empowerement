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
    SELECT COALESCE(
      (SELECT ps.setting_value
         FROM public.pos_settings ps, tx
        WHERE ps.business_id = tx.business_id
          AND ps.setting_key = 'receipt_settings'
          AND ps.register_id = tx.register_id
        LIMIT 1),
      (SELECT ps.setting_value
         FROM public.pos_settings ps, tx
        WHERE ps.business_id = tx.business_id
          AND ps.setting_key = 'receipt_settings'
          AND ps.register_id IS NULL
          AND ps.branch_id = tx.branch_id
        LIMIT 1),
      (SELECT ps.setting_value
         FROM public.pos_settings ps, tx
        WHERE ps.business_id = tx.business_id
          AND ps.setting_key = 'receipt_settings'
          AND ps.register_id IS NULL
          AND ps.branch_id IS NULL
        LIMIT 1)
    ) AS register_receipt_settings
  )
  SELECT jsonb_build_object(
    'schema_version', 3,
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