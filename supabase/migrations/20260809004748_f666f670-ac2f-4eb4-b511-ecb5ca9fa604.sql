-- ============================================================
-- Phase 3 · Quantity ledger + invoice line provenance
-- ============================================================

-- 1. Provenance on invoice lines. Without this, "how much of this order line
--    is billed?" is unanswerable and every screen guesses by re-summing.
ALTER TABLE public.invoice_items
  ADD COLUMN IF NOT EXISTS sales_order_item_id uuid
    REFERENCES public.sales_order_items(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS delivery_note_item_id uuid
    REFERENCES public.delivery_note_items(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS invoice_items_so_item_idx
  ON public.invoice_items (sales_order_item_id)
  WHERE sales_order_item_id IS NOT NULL;

-- 2. Ledger columns on the order line.
ALTER TABLE public.sales_order_items
  ADD COLUMN IF NOT EXISTS quantity_invoiced numeric NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS quantity_cancelled numeric NOT NULL DEFAULT 0;

COMMENT ON COLUMN public.sales_order_items.quantity_invoiced IS
  'Maintained by trg_so_item_invoiced_qty from linked invoice_items on live invoices. Never write directly.';
COMMENT ON COLUMN public.sales_order_items.quantity_cancelled IS
  'Open quantity written off when the order is cancelled. Set by cancel_sales_order_atomic.';

-- 3. Trigger-maintained billed quantity.
CREATE OR REPLACE FUNCTION public._recalc_so_item_invoiced(p_so_item_ids uuid[])
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  UPDATE public.sales_order_items soi
     SET quantity_invoiced = COALESCE(agg.qty, 0)
    FROM (
      SELECT s.id,
             (SELECT COALESCE(SUM(ii.quantity), 0)
                FROM public.invoice_items ii
                JOIN public.invoices inv ON inv.id = ii.invoice_id
               WHERE ii.sales_order_item_id = s.id
                 AND COALESCE(inv.status::text, '') NOT IN ('cancelled','void','voided')) AS qty
        FROM public.sales_order_items s
       WHERE s.id = ANY(p_so_item_ids)
    ) agg
   WHERE soi.id = agg.id
     AND soi.quantity_invoiced IS DISTINCT FROM COALESCE(agg.qty, 0);
$function$;

CREATE OR REPLACE FUNCTION public.trg_so_item_invoiced_qty()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE v_ids uuid[];
BEGIN
  IF TG_OP = 'INSERT' THEN
    v_ids := ARRAY[NEW.sales_order_item_id];
  ELSIF TG_OP = 'DELETE' THEN
    v_ids := ARRAY[OLD.sales_order_item_id];
  ELSE
    v_ids := ARRAY[NEW.sales_order_item_id, OLD.sales_order_item_id];
  END IF;

  v_ids := ARRAY(SELECT DISTINCT x FROM unnest(v_ids) x WHERE x IS NOT NULL);
  IF array_length(v_ids, 1) > 0 THEN
    PERFORM public._recalc_so_item_invoiced(v_ids);
  END IF;
  RETURN NULL;
END;
$function$;

DROP TRIGGER IF EXISTS trg_invoice_items_so_ledger ON public.invoice_items;
CREATE TRIGGER trg_invoice_items_so_ledger
  AFTER INSERT OR DELETE OR UPDATE OF quantity, sales_order_item_id ON public.invoice_items
  FOR EACH ROW EXECUTE FUNCTION public.trg_so_item_invoiced_qty();

-- Voiding/cancelling an invoice must release its billed quantity.
CREATE OR REPLACE FUNCTION public.trg_invoice_status_so_ledger()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE v_ids uuid[];
BEGIN
  IF NEW.status::text IS DISTINCT FROM OLD.status::text THEN
    SELECT ARRAY(SELECT DISTINCT ii.sales_order_item_id
                   FROM public.invoice_items ii
                  WHERE ii.invoice_id = NEW.id
                    AND ii.sales_order_item_id IS NOT NULL)
      INTO v_ids;
    IF array_length(v_ids, 1) > 0 THEN
      PERFORM public._recalc_so_item_invoiced(v_ids);
    END IF;
  END IF;
  RETURN NULL;
END;
$function$;

DROP TRIGGER IF EXISTS trg_invoices_status_so_ledger ON public.invoices;
CREATE TRIGGER trg_invoices_status_so_ledger
  AFTER UPDATE OF status ON public.invoices
  FOR EACH ROW EXECUTE FUNCTION public.trg_invoice_status_so_ledger();

-- 4. One place to read fulfilment progress from.
CREATE OR REPLACE VIEW public.so_line_balances
WITH (security_invoker = true)
AS
SELECT
  soi.id                                AS sales_order_item_id,
  soi.sales_order_id,
  so.organization_id,
  so.business_id,
  so.branch_id,
  so.so_number,
  so.status                             AS order_status,
  soi.product_id,
  soi.description,
  soi.quantity                           AS quantity_ordered,
  COALESCE(soi.quantity_fulfilled, 0)    AS quantity_delivered,
  COALESCE(soi.quantity_invoiced, 0)     AS quantity_invoiced,
  COALESCE(ret.qty, 0)                   AS quantity_returned,
  COALESCE(soi.quantity_cancelled, 0)    AS quantity_cancelled,
  GREATEST(soi.quantity
           - COALESCE(soi.quantity_fulfilled, 0)
           - COALESCE(soi.quantity_cancelled, 0), 0) AS quantity_open_to_deliver,
  GREATEST(soi.quantity
           - COALESCE(soi.quantity_invoiced, 0)
           - COALESCE(soi.quantity_cancelled, 0), 0) AS quantity_open_to_invoice,
  soi.unit_price,
  soi.line_total
FROM public.sales_order_items soi
JOIN public.sales_orders so ON so.id = soi.sales_order_id
LEFT JOIN LATERAL (
  SELECT COALESCE(SUM(dni.quantity_delivered), 0) AS qty
    FROM public.delivery_note_items dni
    JOIN public.delivery_notes dn ON dn.id = dni.delivery_note_id
   WHERE dni.sales_order_item_id = soi.id
     AND COALESCE(dn.is_return, false) = true
     AND dn.status IN ('returned','delivered','partial')
) ret ON true;

GRANT SELECT ON public.so_line_balances TO authenticated;

COMMENT ON VIEW public.so_line_balances IS
  'Canonical per-line sales order ledger: ordered / delivered / invoiced / returned / cancelled and the two open balances. Read this instead of re-summing delivery or invoice lines in application code.';

-- 5. Order-route invoicing: bill the UNBILLED quantity, carry FX, record the line link.
CREATE OR REPLACE FUNCTION public.convert_so_to_invoice_atomic(p_so_id uuid, p_user_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_so RECORD;
  v_inv_number text;
  v_inv_id uuid;
  v_spawned_count int;
  v_all_fulfilled boolean;
  v_any_fulfilled boolean;
  v_new_status text;
  v_subtotal numeric := 0;
  v_tax numeric := 0;
  v_total numeric := 0;
  v_line_count int := 0;
  v_open_left numeric := 0;
BEGIN
  SELECT * INTO v_so FROM public.sales_orders WHERE id = p_so_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Sales order % not found', p_so_id; END IF;

  IF v_so.converted_invoice_id IS NOT NULL THEN
    RAISE EXCEPTION 'Sales order % already converted to invoice %', v_so.so_number, v_so.converted_invoice_id;
  END IF;

  PERFORM 1 FROM public.delivery_notes
   WHERE sales_order_id = p_so_id
   FOR UPDATE;

  SELECT count(*) INTO v_spawned_count
    FROM public.delivery_notes
   WHERE sales_order_id = p_so_id
     AND spawned_invoice_id IS NOT NULL;
  IF v_spawned_count > 0 THEN
    RAISE EXCEPTION 'Sales order % already has % invoice(s) raised from its delivery notes — cannot raise a duplicate invoice from the SO.',
      v_so.so_number, v_spawned_count
      USING ERRCODE = '22023';
  END IF;

  IF v_so.status NOT IN ('confirmed','processing','partial','fulfilled') THEN
    RAISE EXCEPTION 'Cannot convert sales order in status % — must be confirmed first', v_so.status;
  END IF;
  IF NOT public.user_can_access_business(p_user_id, v_so.business_id) THEN
    RAISE EXCEPTION 'Access denied for business %', v_so.business_id;
  END IF;

  -- Bill only what is genuinely open to invoice. Copying the header total
  -- re-billed cancelled or already-billed quantity.
  SELECT
    COALESCE(SUM(round(b.quantity_open_to_invoice * soi.unit_price
                       * (1 - COALESCE(soi.discount_percent,0)/100.0), 2)), 0),
    COALESCE(SUM(round(b.quantity_open_to_invoice * soi.unit_price
                       * (1 - COALESCE(soi.discount_percent,0)/100.0)
                       * COALESCE(soi.tax_rate,0) / 100.0, 2)), 0),
    count(*)
  INTO v_subtotal, v_tax, v_line_count
  FROM public.so_line_balances b
  JOIN public.sales_order_items soi ON soi.id = b.sales_order_item_id
  WHERE b.sales_order_id = p_so_id
    AND b.quantity_open_to_invoice > 0;

  IF v_line_count = 0 THEN
    RAISE EXCEPTION 'Sales order % has nothing left to invoice', v_so.so_number USING ERRCODE = '22023';
  END IF;

  v_total := round(v_subtotal + v_tax - COALESCE(v_so.discount_amount, 0), 2);

  SELECT public.get_next_invoice_number(v_so.organization_id, v_so.business_id) INTO v_inv_number;

  INSERT INTO public.invoices(
    organization_id, business_id, branch_id, contact_id,
    invoice_number, status, issue_date, due_date,
    subtotal, tax_amount, discount_amount, total, currency, exchange_rate,
    notes, created_by, salesperson_id, payment_term_id,
    source_sales_order_id
  ) VALUES (
    v_so.organization_id, v_so.business_id, v_so.branch_id, v_so.contact_id,
    v_inv_number, 'draft', CURRENT_DATE, CURRENT_DATE + INTERVAL '30 days',
    v_subtotal, v_tax, COALESCE(v_so.discount_amount, 0), v_total, v_so.currency,
    v_so.exchange_rate,
    v_so.notes, p_user_id, COALESCE(v_so.salesperson_id, p_user_id), v_so.payment_term_id,
    p_so_id
  ) RETURNING id INTO v_inv_id;

  INSERT INTO public.invoice_items(
    invoice_id, product_id, description, quantity, unit_price,
    tax_rate, tax_amount, discount_percent, line_total, sort_order,
    project_id, task_id, packaging_id, display_uom_id, uom_snapshot,
    sales_order_item_id
  )
  SELECT
    v_inv_id, soi.product_id, soi.description,
    b.quantity_open_to_invoice, soi.unit_price,
    COALESCE(soi.tax_rate,0),
    round(b.quantity_open_to_invoice * soi.unit_price
          * (1 - COALESCE(soi.discount_percent,0)/100.0)
          * COALESCE(soi.tax_rate,0) / 100.0, 2),
    COALESCE(soi.discount_percent,0),
    round(b.quantity_open_to_invoice * soi.unit_price
          * (1 - COALESCE(soi.discount_percent,0)/100.0), 2),
    soi.sort_order,
    soi.project_id, soi.task_id, soi.packaging_id, soi.display_uom_id, soi.uom_snapshot,
    soi.id
  FROM public.so_line_balances b
  JOIN public.sales_order_items soi ON soi.id = b.sales_order_item_id
  WHERE b.sales_order_id = p_so_id
    AND b.quantity_open_to_invoice > 0;

  SELECT bool_and(COALESCE(quantity_fulfilled,0) >= quantity),
         bool_or(COALESCE(quantity_fulfilled,0) > 0)
    INTO v_all_fulfilled, v_any_fulfilled
    FROM public.sales_order_items
   WHERE sales_order_id = p_so_id;

  SELECT COALESCE(SUM(quantity_open_to_invoice), 0) INTO v_open_left
    FROM public.so_line_balances WHERE sales_order_id = p_so_id;

  v_new_status := CASE
    WHEN v_open_left <= 0 AND v_all_fulfilled THEN 'invoiced'
    WHEN v_open_left <= 0 THEN 'invoiced'
    WHEN v_any_fulfilled THEN 'partial'
    ELSE v_so.status
  END;

  UPDATE public.sales_orders
  SET status = v_new_status,
      converted_invoice_id = v_inv_id,
      converted_at = now(),
      updated_at = now()
  WHERE id = p_so_id;

  RETURN jsonb_build_object(
    'success', true,
    'invoice_id', v_inv_id,
    'invoice_number', v_inv_number,
    'so_status', v_new_status,
    'lines_invoiced', v_line_count,
    'total', v_total
  );
END;
$function$;

-- 6. Delivery-route invoicing: record BOTH links so the ledger sees it.
CREATE OR REPLACE FUNCTION public.create_invoice_from_delivery_atomic(p_dn_id uuid, p_user_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
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
  v_rate numeric;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'auth required' USING ERRCODE='42501';
  END IF;

  SELECT id, organization_id, business_id, branch_id, contact_id,
         delivery_number, status, source_invoice_id, spawned_invoice_id,
         auto_invoice_on_complete, notes, sales_order_id
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

  -- Inherit the order's captured rate when this delivery belongs to an order.
  IF v_dn.sales_order_id IS NOT NULL THEN
    SELECT exchange_rate, COALESCE(currency, v_currency)
      INTO v_rate, v_currency
      FROM public.sales_orders WHERE id = v_dn.sales_order_id;
  END IF;

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
    subtotal, tax_amount, discount_amount, total, currency, exchange_rate,
    notes, created_by, source_delivery_note_id, source_sales_order_id
  ) VALUES (
    v_dn.organization_id, v_dn.business_id, v_dn.branch_id, v_dn.contact_id,
    v_inv_number, 'draft', CURRENT_DATE, CURRENT_DATE + INTERVAL '30 days',
    v_subtotal, v_tax_total, 0, v_total, v_currency, v_rate,
    NULL, p_user_id, p_dn_id, v_dn.sales_order_id
  )
  RETURNING id INTO v_inv_id;

  INSERT INTO public.invoice_items(
    invoice_id, product_id, description, quantity, unit_price,
    tax_rate, tax_amount, discount_percent, line_total, sort_order,
    sales_order_item_id, delivery_note_item_id
  )
  SELECT
    v_inv_id, dni.product_id, dni.description, dni.quantity_delivered, dni.unit_price,
    COALESCE(dni.tax_rate, 0), COALESCE(dni.tax_amount, 0),
    COALESCE(dni.discount_percent, 0),
    COALESCE(dni.line_total,
             dni.quantity_delivered * dni.unit_price * (1 - COALESCE(dni.discount_percent,0)/100.0)
             + COALESCE(dni.tax_amount,0)),
    COALESCE(dni.sort_order, 0),
    dni.sales_order_item_id, dni.id
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
END $function$;

-- 7. Cancellation writes the cancelled quantity into the ledger.
CREATE OR REPLACE FUNCTION public._so_write_cancelled_quantities(p_so_id uuid)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  UPDATE public.sales_order_items
     SET quantity_cancelled = GREATEST(
           quantity - COALESCE(quantity_fulfilled, 0) - COALESCE(quantity_invoiced, 0), 0)
   WHERE sales_order_id = p_so_id;
$function$;

-- 8. Backfill: reconstruct billed quantity where the delivery link exists.
UPDATE public.invoice_items ii
   SET sales_order_item_id = dni.sales_order_item_id,
       delivery_note_item_id = dni.id
  FROM public.invoices inv
  JOIN public.delivery_note_items dni
    ON dni.delivery_note_id = inv.source_delivery_note_id
 WHERE ii.invoice_id = inv.id
   AND ii.sales_order_item_id IS NULL
   AND inv.source_delivery_note_id IS NOT NULL
   AND dni.sales_order_item_id IS NOT NULL
   AND dni.product_id IS NOT DISTINCT FROM ii.product_id;

SELECT public._recalc_so_item_invoiced(
  ARRAY(SELECT DISTINCT sales_order_item_id FROM public.invoice_items
         WHERE sales_order_item_id IS NOT NULL));
