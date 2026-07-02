
-- 1. Schema -------------------------------------------------------------

ALTER TABLE public.delivery_notes
  ADD COLUMN IF NOT EXISTS source_invoice_id uuid
    REFERENCES public.invoices(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS received_by_user_id uuid
    REFERENCES auth.users(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_delivery_notes_source_invoice_id
  ON public.delivery_notes(source_invoice_id)
  WHERE source_invoice_id IS NOT NULL;

-- 2. Business-match trigger for source_invoice_id -----------------------

CREATE OR REPLACE FUNCTION public._dn_source_invoice_business_match()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_inv_biz uuid;
  v_inv_org uuid;
BEGIN
  IF NEW.source_invoice_id IS NULL THEN
    RETURN NEW;
  END IF;
  SELECT business_id, organization_id INTO v_inv_biz, v_inv_org
    FROM public.invoices WHERE id = NEW.source_invoice_id;
  IF v_inv_biz IS NULL THEN
    RAISE EXCEPTION 'source_invoice_id % does not exist', NEW.source_invoice_id;
  END IF;
  IF v_inv_biz <> NEW.business_id OR v_inv_org <> NEW.organization_id THEN
    RAISE EXCEPTION 'source_invoice_id business/org does not match delivery note';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_dn_source_invoice_business_match ON public.delivery_notes;
CREATE TRIGGER trg_dn_source_invoice_business_match
  BEFORE INSERT OR UPDATE OF source_invoice_id, business_id, organization_id
  ON public.delivery_notes
  FOR EACH ROW EXECUTE FUNCTION public._dn_source_invoice_business_match();

-- 3. Backfill -----------------------------------------------------------

WITH parsed AS (
  SELECT dn.id AS dn_id, dn.business_id,
         (regexp_match(dn.notes, '\[auto-from-invoice:([0-9a-fA-F-]{36})\]'))[1] AS inv_id
    FROM public.delivery_notes dn
   WHERE dn.source_invoice_id IS NULL
     AND dn.notes ~ '\[auto-from-invoice:[0-9a-fA-F-]{36}\]'
)
UPDATE public.delivery_notes dn
   SET source_invoice_id = parsed.inv_id::uuid
  FROM parsed
  JOIN public.invoices i
    ON i.id = parsed.inv_id::uuid
   AND i.business_id = parsed.business_id
 WHERE dn.id = parsed.dn_id;

UPDATE public.delivery_notes
   SET notes = NULLIF(
         btrim(
           regexp_replace(
             regexp_replace(
               notes,
               '\s*Auto-created from invoice [^\[\n]*\[auto-from-invoice:[0-9a-fA-F-]{36}\]\s*(\(backfill\))?\s*', '', 'g'
             ),
             '\s*\[auto-from-invoice:[0-9a-fA-F-]{36}\]\s*', '', 'g'
           )
         ),
         ''
       )
 WHERE notes ~ '\[auto-from-invoice:[0-9a-fA-F-]{36}\]';

UPDATE public.delivery_notes dn
   SET received_by_user_id = dn.received_by::uuid,
       received_by = NULL
  FROM auth.users u
 WHERE dn.received_by ~ '^[0-9a-fA-F-]{36}$'
   AND u.id = dn.received_by::uuid;

UPDATE public.delivery_notes
   SET received_by = NULL
 WHERE received_by ~ '^[0-9a-fA-F-]{36}$';

UPDATE public.delivery_notes
   SET received_by = NULL
 WHERE received_by = 'Customer';

-- 4. confirm_invoice_atomic --------------------------------------------

CREATE OR REPLACE FUNCTION public.confirm_invoice_atomic(
  p_invoice_id uuid,
  p_user_id uuid,
  p_main_lines jsonb,
  p_cogs_lines jsonb DEFAULT NULL::jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_inv record;
  v_je_id uuid;
  v_cogs_je_id uuid;
  v_main_entry_no text;
  v_cogs_entry_no text;
  v_line_count integer;
  v_items_subtotal numeric := 0;
  v_items_tax numeric := 0;
  v_main_debits numeric := 0;
  v_main_credits numeric := 0;
  v_bad_accounts integer := 0;
  v_revenue_line_count integer := 0;
  v_ar_line_count integer := 0;
  v_existing_dn_id uuid;
  v_stockable_count integer := 0;
  v_dn_id uuid;
  v_dn_number text;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'auth required' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_inv FROM public.invoices WHERE id = p_invoice_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Invoice % not found', p_invoice_id; END IF;
  IF v_inv.status <> 'draft' THEN
    RAISE EXCEPTION 'Only draft invoices can be confirmed (current: %)', v_inv.status;
  END IF;
  IF v_inv.business_id IS NULL OR NOT public.user_can_access_business(p_user_id, v_inv.business_id) THEN
    RAISE EXCEPTION 'Access denied for business %', v_inv.business_id USING ERRCODE = '42501';
  END IF;
  IF v_inv.journal_entry_id IS NOT NULL THEN
    RAISE EXCEPTION 'Invoice % is already linked to a journal entry', v_inv.invoice_number;
  END IF;

  PERFORM public.assert_contact_in_business(v_inv.contact_id, v_inv.organization_id, v_inv.business_id, 'invoice customer');
  PERFORM public.assert_no_existing_source_posting(v_inv.organization_id, 'invoice', p_invoice_id, NULL);
  IF p_cogs_lines IS NOT NULL AND jsonb_array_length(p_cogs_lines) >= 2 THEN
    PERFORM public.assert_no_existing_source_posting(v_inv.organization_id, 'invoice', p_invoice_id, 'cogs');
  END IF;

  IF p_main_lines IS NULL OR jsonb_typeof(p_main_lines) <> 'array' OR jsonb_array_length(p_main_lines) < 2 THEN
    RAISE EXCEPTION 'Invoice JE requires at least 2 lines';
  END IF;

  SELECT COUNT(*), COALESCE(ROUND(SUM(line_total), 2), 0), COALESCE(ROUND(SUM(COALESCE(tax_amount, 0)), 2), 0)
    INTO v_line_count, v_items_subtotal, v_items_tax
  FROM public.invoice_items WHERE invoice_id = p_invoice_id;
  IF v_line_count = 0 THEN
    RAISE EXCEPTION 'Invoice % has no lines; cannot confirm', v_inv.invoice_number;
  END IF;
  IF ABS(v_items_subtotal - COALESCE(v_inv.subtotal, 0)) > 0.01
     OR ABS(v_items_tax - COALESCE(v_inv.tax_amount, 0)) > 0.01
     OR ABS(ROUND(v_items_subtotal + v_items_tax - COALESCE(v_inv.discount_amount, 0), 2) - COALESCE(v_inv.total, 0)) > 0.01 THEN
    RAISE EXCEPTION 'Invoice % totals do not match persisted line data', v_inv.invoice_number;
  END IF;

  SELECT
    COALESCE(SUM((l->>'debit')::numeric), 0),
    COALESCE(SUM((l->>'credit')::numeric), 0),
    COUNT(*) FILTER (WHERE a.id IS NULL),
    COUNT(*) FILTER (WHERE a.account_type = 'revenue' AND (l->>'credit')::numeric > 0),
    COUNT(*) FILTER (WHERE a.account_type = 'asset' AND a.detail_type = 'accounts_receivable' AND (l->>'debit')::numeric > 0)
  INTO v_main_debits, v_main_credits, v_bad_accounts, v_revenue_line_count, v_ar_line_count
  FROM jsonb_array_elements(p_main_lines) l
  LEFT JOIN public.accounts a ON a.id = (l->>'account_id')::uuid
                              AND a.organization_id = v_inv.organization_id
                              AND a.business_id = v_inv.business_id;

  IF v_bad_accounts > 0 THEN
    RAISE EXCEPTION 'Invoice JE references % accounts not in this business', v_bad_accounts;
  END IF;
  IF ABS(v_main_debits - v_main_credits) > 0.01 THEN
    RAISE EXCEPTION 'Invoice JE not balanced: debits % credits %', v_main_debits, v_main_credits;
  END IF;
  IF v_revenue_line_count = 0 OR v_ar_line_count = 0 THEN
    RAISE EXCEPTION 'Invoice JE missing required AR or Revenue line';
  END IF;

  SELECT public.get_next_journal_entry_number(v_inv.organization_id) INTO v_main_entry_no;

  v_je_id := public.post_journal_entry_atomic(
    _org_id := v_inv.organization_id,
    _business_id := v_inv.business_id,
    _entry_number := v_main_entry_no,
    _entry_date := v_inv.issue_date,
    _reference := v_inv.invoice_number,
    _description := 'Invoice ' || v_inv.invoice_number,
    _source_type := 'invoice',
    _source_id := p_invoice_id,
    _created_by := p_user_id,
    _is_closing := false,
    _is_adjusting := false,
    _lines := p_main_lines,
    _currency := v_inv.currency,
    _exchange_rate := NULL,
    _source_subtype := NULL,
    _branch_id := v_inv.branch_id
  );

  IF p_cogs_lines IS NOT NULL AND jsonb_array_length(p_cogs_lines) >= 2 THEN
    SELECT public.get_next_journal_entry_number(v_inv.organization_id) INTO v_cogs_entry_no;
    v_cogs_je_id := public.post_journal_entry_atomic(
      _org_id := v_inv.organization_id, _business_id := v_inv.business_id,
      _entry_number := v_cogs_entry_no, _entry_date := v_inv.issue_date,
      _reference := 'COGS-' || v_inv.invoice_number,
      _description := 'COGS for invoice ' || v_inv.invoice_number,
      _source_type := 'invoice', _source_id := p_invoice_id,
      _created_by := p_user_id, _is_closing := false, _is_adjusting := false,
      _lines := p_cogs_lines, _currency := v_inv.currency,
      _exchange_rate := NULL, _source_subtype := 'cogs', _branch_id := v_inv.branch_id
    );
  END IF;

  UPDATE public.invoices
  SET status = 'confirmed', journal_entry_id = v_je_id, updated_at = now()
  WHERE id = p_invoice_id;

  IF v_inv.source_sales_order_id IS NULL THEN
    SELECT id INTO v_existing_dn_id
      FROM public.delivery_notes
     WHERE source_invoice_id = p_invoice_id
     LIMIT 1;

    IF v_existing_dn_id IS NULL THEN
      SELECT COUNT(*) INTO v_stockable_count
        FROM public.invoice_items ii
        JOIN public.products p ON p.id = ii.product_id
       WHERE ii.invoice_id = p_invoice_id
         AND COALESCE(p.track_inventory, true) = true
         AND p.type = 'product'
         AND COALESCE(ii.quantity, 0) > 0;

      IF v_stockable_count > 0 THEN
        v_dn_number := public.get_next_delivery_number(v_inv.organization_id);

        INSERT INTO public.delivery_notes (
          organization_id, business_id, branch_id,
          contact_id, delivery_number, delivery_date, status,
          sales_order_id, source_invoice_id, notes, created_by
        ) VALUES (
          v_inv.organization_id, v_inv.business_id, v_inv.branch_id,
          v_inv.contact_id, v_dn_number, v_inv.issue_date, 'pending',
          NULL, p_invoice_id, NULL, p_user_id
        )
        RETURNING id INTO v_dn_id;

        INSERT INTO public.delivery_note_items (
          delivery_note_id, product_id, description,
          quantity_ordered, quantity_delivered, sort_order
        )
        SELECT
          v_dn_id, ii.product_id, ii.description,
          ii.quantity, ii.quantity, COALESCE(ii.sort_order, 0)
        FROM public.invoice_items ii
        JOIN public.products p ON p.id = ii.product_id
       WHERE ii.invoice_id = p_invoice_id
         AND COALESCE(p.track_inventory, true) = true
         AND p.type = 'product'
         AND COALESCE(ii.quantity, 0) > 0;
      END IF;
    END IF;
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'journal_entry_id', v_je_id,
    'cogs_journal_entry_id', v_cogs_je_id,
    'delivery_note_id', v_dn_id,
    'delivery_number', v_dn_number,
    'auto_delivery_created', v_dn_id IS NOT NULL
  );
END;
$function$;

-- 5. complete_delivery_atomic ------------------------------------------

CREATE OR REPLACE FUNCTION public.complete_delivery_atomic(
  p_dn_id uuid,
  p_user_id uuid,
  p_received_by text DEFAULT NULL,
  p_pod jsonb DEFAULT NULL,
  p_received_by_user_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_dn record;
  v_so_branch_id uuid;
  v_warehouse_id uuid;
  v_branch_id uuid;
  v_org_id uuid;
  v_biz_id uuid;
  v_item record;
  v_unit_cost numeric;
  v_line_cost numeric;
  v_total_cogs numeric := 0;
  v_inventory_acct uuid;
  v_cogs_acct uuid;
  v_journal_id uuid;
  v_entry_no text;
  v_movement_count int := 0;
  v_so_id uuid;
  v_all_fulfilled boolean;
  v_any_fulfilled boolean;
  v_cogs_lines jsonb;
  v_currency text;
  v_pod_id uuid;
  v_is_partial boolean := false;
  v_pod_contact uuid;
  v_received_by_clean text;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'auth required' USING ERRCODE='42501'; END IF;

  IF p_received_by IS NOT NULL AND p_received_by ~ '^[0-9a-fA-F-]{36}$' THEN
    RAISE EXCEPTION 'p_received_by must be a recipient name, not a user id (got %). Pass the staff user id via p_received_by_user_id.', p_received_by
      USING ERRCODE='22023';
  END IF;
  v_received_by_clean := NULLIF(btrim(COALESCE(p_received_by, '')), '');

  SELECT id, organization_id, business_id, branch_id, sales_order_id, delivery_number, status
    INTO v_dn FROM public.delivery_notes WHERE id = p_dn_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('success', false, 'error', 'Delivery note not found'); END IF;

  IF v_dn.status IN ('delivered','partial','cancelled') THEN
    RETURN jsonb_build_object('success', false, 'error', 'Delivery already finalised');
  END IF;

  v_org_id := v_dn.organization_id;
  v_biz_id := v_dn.business_id;
  v_so_id := v_dn.sales_order_id;

  IF v_biz_id IS NULL OR NOT public.user_can_access_business(p_user_id, v_biz_id) THEN
    RAISE EXCEPTION 'Access denied for business %', v_biz_id USING ERRCODE='42501';
  END IF;

  SELECT id, branch_id INTO v_warehouse_id, v_branch_id
    FROM public.warehouses
   WHERE organization_id = v_org_id AND business_id = v_biz_id
     AND COALESCE(branch_id, '00000000-0000-0000-0000-000000000000'::uuid)
         = COALESCE(v_dn.branch_id, '00000000-0000-0000-0000-000000000000'::uuid)
     AND is_active = true AND COALESCE(is_in_transit, false) = false
   ORDER BY is_default DESC NULLS LAST, created_at ASC LIMIT 1;

  IF v_warehouse_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'No active warehouse found for this branch — create one before delivering.');
  END IF;

  IF v_so_id IS NOT NULL THEN
    SELECT branch_id INTO v_so_branch_id FROM public.sales_orders WHERE id = v_so_id;
    IF v_so_branch_id IS NOT NULL AND v_branch_id IS NOT NULL AND v_so_branch_id <> v_branch_id THEN
      RETURN jsonb_build_object('success', false, 'error', 'Sales order is in a different branch than the warehouse.');
    END IF;
  END IF;

  FOR v_item IN
    SELECT dni.id, dni.product_id, dni.description, dni.quantity_ordered, dni.quantity_delivered,
           dni.sales_order_item_id, p.cost_price, p.track_inventory
      FROM public.delivery_note_items dni
 LEFT JOIN public.products p ON p.id = dni.product_id
     WHERE dni.delivery_note_id = p_dn_id AND dni.quantity_delivered > 0
  LOOP
    IF v_item.quantity_delivered < v_item.quantity_ordered THEN
      v_is_partial := true;
    END IF;
    IF v_item.sales_order_item_id IS NOT NULL THEN
      UPDATE public.sales_order_items
         SET quantity_fulfilled = COALESCE(quantity_fulfilled, 0) + v_item.quantity_delivered
       WHERE id = v_item.sales_order_item_id;
    END IF;
    IF v_item.product_id IS NULL OR NOT COALESCE(v_item.track_inventory, true) THEN CONTINUE; END IF;

    v_unit_cost := COALESCE(v_item.cost_price, 0);
    INSERT INTO public.stock_movements (
      organization_id, business_id, branch_id, warehouse_id,
      product_id, movement_type, quantity, unit_cost,
      reference_type, reference_id, notes, created_by
    ) VALUES (
      v_org_id, v_biz_id, v_branch_id, v_warehouse_id,
      v_item.product_id, 'delivery', -ABS(v_item.quantity_delivered), v_unit_cost,
      'delivery_note', p_dn_id,
      'Delivery ' || v_dn.delivery_number || COALESCE(' — ' || v_item.description, ''),
      p_user_id
    );
    v_movement_count := v_movement_count + 1;
    v_line_cost := ABS(v_item.quantity_delivered) * v_unit_cost;
    v_total_cogs := v_total_cogs + v_line_cost;
  END LOOP;

  IF v_total_cogs > 0 THEN
    SELECT COALESCE(base_currency, 'USD') INTO v_currency FROM public.businesses WHERE id = v_biz_id;
    SELECT id INTO v_inventory_acct FROM public.accounts
     WHERE organization_id = v_org_id AND business_id = v_biz_id
       AND detail_type = 'inventory' AND is_active = true LIMIT 1;
    SELECT id INTO v_cogs_acct FROM public.accounts
     WHERE organization_id = v_org_id AND business_id = v_biz_id
       AND detail_type = 'cost_of_goods_sold' AND is_active = true LIMIT 1;

    IF v_inventory_acct IS NOT NULL AND v_cogs_acct IS NOT NULL THEN
      SELECT public.get_next_journal_entry_number(v_org_id) INTO v_entry_no;
      v_cogs_lines := jsonb_build_array(
        jsonb_build_object('account_id', v_cogs_acct, 'debit', v_total_cogs, 'credit', 0, 'description', 'COGS - ' || v_dn.delivery_number),
        jsonb_build_object('account_id', v_inventory_acct, 'debit', 0, 'credit', v_total_cogs, 'description', 'Inventory reduction - ' || v_dn.delivery_number)
      );
      v_journal_id := public.post_journal_entry_atomic(
        _org_id := v_org_id, _business_id := v_biz_id,
        _entry_number := v_entry_no, _entry_date := CURRENT_DATE,
        _reference := 'COGS-' || v_dn.delivery_number,
        _description := 'COGS for delivery ' || v_dn.delivery_number,
        _source_type := 'delivery_note', _source_id := p_dn_id,
        _created_by := p_user_id, _is_closing := false, _is_adjusting := false,
        _lines := v_cogs_lines, _currency := v_currency, _exchange_rate := NULL,
        _source_subtype := 'cogs', _branch_id := v_branch_id
      );
    END IF;
  END IF;

  v_pod_contact := NULLIF(p_pod->>'received_by_contact_id','')::uuid;

  UPDATE public.delivery_notes
     SET status = CASE WHEN v_is_partial THEN 'partial' ELSE 'delivered' END,
         delivered_at = now(),
         received_by = COALESCE(v_received_by_clean, received_by),
         received_by_contact_id = COALESCE(v_pod_contact, received_by_contact_id),
         received_by_user_id = COALESCE(p_received_by_user_id, received_by_user_id),
         updated_at = now()
   WHERE id = p_dn_id;

  IF p_pod IS NOT NULL AND p_pod <> '{}'::jsonb THEN
    INSERT INTO public.delivery_proofs (
      delivery_note_id, organization_id, business_id,
      signature_url, photo_urls, received_by_contact_id, received_by_name,
      received_at, gps_lat, gps_lng, notes, created_by
    ) VALUES (
      p_dn_id, v_org_id, v_biz_id,
      p_pod->>'signature_url',
      COALESCE(ARRAY(SELECT jsonb_array_elements_text(p_pod->'photo_urls')), ARRAY[]::text[]),
      v_pod_contact,
      COALESCE(p_pod->>'received_by_name', v_received_by_clean),
      COALESCE(NULLIF(p_pod->>'received_at','')::timestamptz, now()),
      NULLIF(p_pod->>'gps_lat','')::numeric,
      NULLIF(p_pod->>'gps_lng','')::numeric,
      p_pod->>'notes',
      p_user_id
    ) RETURNING id INTO v_pod_id;
  END IF;

  IF v_so_id IS NOT NULL THEN
    SELECT bool_and(quantity_fulfilled >= quantity), bool_or(quantity_fulfilled > 0)
      INTO v_all_fulfilled, v_any_fulfilled
      FROM public.sales_order_items WHERE sales_order_id = v_so_id;
    IF v_all_fulfilled THEN
      UPDATE public.sales_orders SET status = 'fulfilled', updated_at = now()
       WHERE id = v_so_id AND status NOT IN ('invoiced','cancelled');
    ELSIF v_any_fulfilled THEN
      UPDATE public.sales_orders SET status = 'partial', updated_at = now()
       WHERE id = v_so_id AND status NOT IN ('invoiced','cancelled','fulfilled');
    END IF;
  END IF;

  PERFORM public._log_dn_event(p_dn_id, CASE WHEN v_is_partial THEN 'partially_delivered' ELSE 'delivered' END,
    p_user_id, v_received_by_clean,
    jsonb_build_object('movements', v_movement_count, 'cogs', v_total_cogs, 'pod_id', v_pod_id));

  RETURN jsonb_build_object(
    'success', true, 'delivery_id', p_dn_id, 'warehouse_id', v_warehouse_id,
    'movements_created', v_movement_count, 'gl_posted', v_journal_id IS NOT NULL,
    'cogs_total', v_total_cogs, 'pod_id', v_pod_id, 'partial', v_is_partial
  );
END $function$;

-- 6. confirm_invoice_and_release_stock_atomic --------------------------

CREATE OR REPLACE FUNCTION public.confirm_invoice_and_release_stock_atomic(
  p_invoice_id uuid,
  p_user_id uuid,
  p_main_lines jsonb,
  p_release_stock boolean DEFAULT true,
  p_warehouse_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_confirm jsonb;
  v_status text;
  v_dn_id uuid;
  v_delivery jsonb;
BEGIN
  SELECT status::text INTO v_status
    FROM public.invoices
   WHERE id = p_invoice_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Invoice % not found', p_invoice_id;
  END IF;

  IF v_status = 'draft' THEN
    v_confirm := public.confirm_invoice_atomic(
      p_invoice_id := p_invoice_id,
      p_user_id := p_user_id,
      p_main_lines := p_main_lines,
      p_cogs_lines := NULL
    );
  ELSE
    v_confirm := jsonb_build_object('success', true);
  END IF;

  SELECT dn.id INTO v_dn_id
    FROM public.delivery_notes dn
    JOIN public.invoices i ON i.id = p_invoice_id
   WHERE dn.organization_id = i.organization_id
     AND dn.business_id = i.business_id
     AND (
       dn.source_invoice_id = p_invoice_id
       OR (i.source_sales_order_id IS NOT NULL AND dn.sales_order_id = i.source_sales_order_id)
     )
   ORDER BY dn.created_at DESC
   LIMIT 1;

  IF p_release_stock AND v_dn_id IS NOT NULL THEN
    v_delivery := public.complete_delivery_atomic(
      p_dn_id := v_dn_id,
      p_user_id := p_user_id,
      p_received_by := NULL,
      p_pod := NULL,
      p_received_by_user_id := p_user_id
    );
    IF NOT COALESCE((v_delivery->>'success')::boolean, false) THEN
      RAISE EXCEPTION 'Stock release failed: %', COALESCE(v_delivery->>'error', 'unknown error');
    END IF;
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'journal_entry_id', v_confirm->>'journal_entry_id',
    'delivery_note_id', v_dn_id,
    'stock_released', p_release_stock AND v_dn_id IS NOT NULL,
    'delivery_result', v_delivery
  );
END;
$function$;
