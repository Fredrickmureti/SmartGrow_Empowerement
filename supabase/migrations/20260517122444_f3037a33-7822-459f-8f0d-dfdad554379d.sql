
-- Round 5: account-resolution parity for DN→Invoice spawn

ALTER TABLE public.delivery_notes
  ADD COLUMN IF NOT EXISTS accounts_resolved jsonb;

COMMENT ON COLUMN public.delivery_notes.accounts_resolved IS
  'Snapshot of GL accounts the spawned invoice will post to. Populated by create_invoice_from_delivery_atomic. Shape: { ar_account_id, ar_account_code, revenue_by_product: [{product_id, account_id, account_code}] }';

-- SQL helper: resolve invoice-style GL accounts for a (org, business, contact)
-- and a set of product_ids. Mirrors the client-side resolver in
-- src/lib/resolveProductAccounts.ts and src/hooks/invoices/confirmInvoiceGL.ts.
-- Priority for AR: contacts.default_receivable_account_id → default_account_settings('accounts_receivable')
-- Priority for revenue per product: products.sales_account_id → default_account_settings('sales_revenue')
CREATE OR REPLACE FUNCTION public._resolve_invoice_gl_accounts(
  p_org_id uuid,
  p_business_id uuid,
  p_contact_id uuid,
  p_product_ids uuid[]
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_ar_account_id uuid;
  v_ar_default uuid;
  v_revenue_default uuid;
  v_ar_code text;
  v_result jsonb;
  v_revenue_lines jsonb;
BEGIN
  SELECT account_id INTO v_ar_default
    FROM public.default_account_settings
   WHERE organization_id = p_org_id
     AND (business_id = p_business_id OR business_id IS NULL)
     AND setting_key = 'accounts_receivable'
   ORDER BY business_id NULLS LAST
   LIMIT 1;

  SELECT account_id INTO v_revenue_default
    FROM public.default_account_settings
   WHERE organization_id = p_org_id
     AND (business_id = p_business_id OR business_id IS NULL)
     AND setting_key = 'sales_revenue'
   ORDER BY business_id NULLS LAST
   LIMIT 1;

  -- AR: contact override wins
  IF p_contact_id IS NOT NULL THEN
    SELECT default_receivable_account_id INTO v_ar_account_id
      FROM public.contacts WHERE id = p_contact_id;
  END IF;
  v_ar_account_id := COALESCE(v_ar_account_id, v_ar_default);

  SELECT code INTO v_ar_code FROM public.accounts WHERE id = v_ar_account_id;

  -- Per-product revenue (product override → default)
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'product_id', p.id,
           'product_name', p.name,
           'account_id', COALESCE(p.sales_account_id, v_revenue_default),
           'account_code', (SELECT code FROM public.accounts WHERE id = COALESCE(p.sales_account_id, v_revenue_default))
         ) ORDER BY p.name), '[]'::jsonb)
    INTO v_revenue_lines
    FROM public.products p
   WHERE p.id = ANY(COALESCE(p_product_ids, ARRAY[]::uuid[]));

  v_result := jsonb_build_object(
    'ar_account_id', v_ar_account_id,
    'ar_account_code', v_ar_code,
    'revenue_default_account_id', v_revenue_default,
    'revenue_by_product', v_revenue_lines,
    'resolved_at', now()
  );

  RETURN v_result;
END $$;

GRANT EXECUTE ON FUNCTION public._resolve_invoice_gl_accounts(uuid, uuid, uuid, uuid[]) TO authenticated;

-- Extend create_invoice_from_delivery_atomic to compute and stamp the
-- account preview. Behavior is otherwise identical to the round-3 version.
CREATE OR REPLACE FUNCTION public.create_invoice_from_delivery_atomic(
  p_dn_id uuid,
  p_user_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_dn record;
  v_inv_id uuid;
  v_inv_number text;
  v_missing_price int;
  v_subtotal numeric := 0;
  v_tax_total numeric := 0;
  v_total numeric := 0;
  v_currency text;
  v_product_ids uuid[];
  v_accounts jsonb;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'auth required' USING ERRCODE='42501';
  END IF;

  SELECT id, organization_id, business_id, branch_id, contact_id,
         delivery_number, status, source_invoice_id, spawned_invoice_id,
         auto_invoice_on_complete, notes
    INTO v_dn
    FROM public.delivery_notes
   WHERE id = p_dn_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Delivery note % not found', p_dn_id USING ERRCODE='P0002';
  END IF;

  IF NOT public.user_can_access_business(p_user_id, v_dn.business_id) THEN
    RAISE EXCEPTION 'Access denied for business %', v_dn.business_id USING ERRCODE='42501';
  END IF;

  IF v_dn.source_invoice_id IS NOT NULL THEN
    RAISE EXCEPTION 'Delivery note % was spawned by invoice % — already billed', v_dn.delivery_number, v_dn.source_invoice_id
      USING ERRCODE='22023';
  END IF;
  IF v_dn.spawned_invoice_id IS NOT NULL THEN
    SELECT invoice_number INTO v_inv_number FROM public.invoices WHERE id = v_dn.spawned_invoice_id;
    SELECT accounts_resolved INTO v_accounts FROM public.delivery_notes WHERE id = p_dn_id;
    RETURN jsonb_build_object(
      'success', true, 'invoice_id', v_dn.spawned_invoice_id,
      'invoice_number', v_inv_number, 'already_existed', true,
      'accounts_resolved', v_accounts
    );
  END IF;
  IF v_dn.contact_id IS NULL THEN
    RAISE EXCEPTION 'Delivery note % has no customer — cannot raise an invoice', v_dn.delivery_number
      USING ERRCODE='22023';
  END IF;

  SELECT count(*) INTO v_missing_price
    FROM public.delivery_note_items
   WHERE delivery_note_id = p_dn_id
     AND quantity_delivered > 0
     AND (unit_price IS NULL);
  IF v_missing_price > 0 THEN
    RAISE EXCEPTION 'Cannot bill delivery %: % line(s) are missing a unit price', v_dn.delivery_number, v_missing_price
      USING ERRCODE='22023';
  END IF;

  SELECT
    COALESCE(SUM(quantity_delivered * unit_price * (1 - COALESCE(discount_percent,0)/100.0)), 0),
    COALESCE(SUM(COALESCE(tax_amount,0)), 0)
  INTO v_subtotal, v_tax_total
  FROM public.delivery_note_items
  WHERE delivery_note_id = p_dn_id AND quantity_delivered > 0;
  v_total := v_subtotal + v_tax_total;

  SELECT COALESCE(base_currency,'USD') INTO v_currency FROM public.businesses WHERE id = v_dn.business_id;
  SELECT public.get_next_invoice_number(v_dn.organization_id, v_dn.business_id) INTO v_inv_number;

  -- Resolve account preview from delivery line products
  SELECT COALESCE(array_agg(DISTINCT product_id) FILTER (WHERE product_id IS NOT NULL), ARRAY[]::uuid[])
    INTO v_product_ids
    FROM public.delivery_note_items
   WHERE delivery_note_id = p_dn_id AND quantity_delivered > 0;

  v_accounts := public._resolve_invoice_gl_accounts(
    v_dn.organization_id, v_dn.business_id, v_dn.contact_id, v_product_ids
  );

  INSERT INTO public.invoices(
    organization_id, business_id, branch_id, contact_id,
    invoice_number, status, issue_date, due_date,
    subtotal, tax_amount, discount_amount, total, currency,
    notes, created_by, source_delivery_note_id
  ) VALUES (
    v_dn.organization_id, v_dn.business_id, v_dn.branch_id, v_dn.contact_id,
    v_inv_number, 'draft', CURRENT_DATE, CURRENT_DATE + INTERVAL '30 days',
    v_subtotal, v_tax_total, 0, v_total, v_currency,
    NULL, p_user_id, p_dn_id
  )
  RETURNING id INTO v_inv_id;

  INSERT INTO public.invoice_items(
    invoice_id, product_id, description, quantity, unit_price,
    tax_rate, tax_amount, discount_percent, line_total, sort_order
  )
  SELECT
    v_inv_id, dni.product_id, dni.description, dni.quantity_delivered, dni.unit_price,
    COALESCE(dni.tax_rate, 0), COALESCE(dni.tax_amount, 0),
    COALESCE(dni.discount_percent, 0),
    COALESCE(dni.line_total,
             dni.quantity_delivered * dni.unit_price * (1 - COALESCE(dni.discount_percent,0)/100.0)
             + COALESCE(dni.tax_amount,0)),
    COALESCE(dni.sort_order, 0)
  FROM public.delivery_note_items dni
  WHERE dni.delivery_note_id = p_dn_id AND dni.quantity_delivered > 0;

  UPDATE public.delivery_notes
     SET spawned_invoice_id = v_inv_id,
         accounts_resolved = v_accounts,
         updated_at = now()
   WHERE id = p_dn_id;

  RETURN jsonb_build_object(
    'success', true, 'invoice_id', v_inv_id,
    'invoice_number', v_inv_number, 'already_existed', false,
    'total', v_total,
    'accounts_resolved', v_accounts
  );
END $$;

GRANT EXECUTE ON FUNCTION public.create_invoice_from_delivery_atomic(uuid, uuid) TO authenticated;
