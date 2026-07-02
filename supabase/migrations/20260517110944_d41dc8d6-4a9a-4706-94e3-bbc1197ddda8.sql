
-- ============================================================
-- Round 3: bidirectional Invoice ↔ Delivery Note atomicity
-- ============================================================

-- 1. Pricing columns on delivery_note_items so a standalone DN can
--    describe a billable transaction. Nullable: pre-existing rows
--    are either invoice-spawned (price lives on invoice line) or
--    pre-feature standalone DNs that never get invoiced.
ALTER TABLE public.delivery_note_items
  ADD COLUMN IF NOT EXISTS unit_price        NUMERIC(15,2),
  ADD COLUMN IF NOT EXISTS tax_rate          NUMERIC(6,3),
  ADD COLUMN IF NOT EXISTS tax_amount        NUMERIC(15,2),
  ADD COLUMN IF NOT EXISTS discount_percent  NUMERIC(6,3) DEFAULT 0,
  ADD COLUMN IF NOT EXISTS line_total        NUMERIC(15,2);

-- 2. Delivery notes: auto-invoice gate + structured back-link.
ALTER TABLE public.delivery_notes
  ADD COLUMN IF NOT EXISTS auto_invoice_on_complete boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS spawned_invoice_id uuid REFERENCES public.invoices(id);

CREATE INDEX IF NOT EXISTS idx_delivery_notes_spawned_invoice_id
  ON public.delivery_notes(spawned_invoice_id)
  WHERE spawned_invoice_id IS NOT NULL;

-- 3. Invoices: symmetric back-link to the DN that spawned them.
ALTER TABLE public.invoices
  ADD COLUMN IF NOT EXISTS source_delivery_note_id uuid REFERENCES public.delivery_notes(id);

CREATE INDEX IF NOT EXISTS idx_invoices_source_delivery_note_id
  ON public.invoices(source_delivery_note_id)
  WHERE source_delivery_note_id IS NOT NULL;

-- 4. Cross-business guard on the new linkage (mirror of
--    _dn_source_invoice_business_match).
CREATE OR REPLACE FUNCTION public._dn_spawned_invoice_business_match()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_dn_biz uuid;
  v_inv_biz uuid;
BEGIN
  IF NEW.spawned_invoice_id IS NULL THEN
    RETURN NEW;
  END IF;
  SELECT business_id INTO v_inv_biz FROM public.invoices WHERE id = NEW.spawned_invoice_id;
  IF v_inv_biz IS NULL THEN
    RAISE EXCEPTION 'spawned_invoice_id % does not exist', NEW.spawned_invoice_id
      USING ERRCODE = '23503';
  END IF;
  IF NEW.business_id IS NOT NULL AND v_inv_biz <> NEW.business_id THEN
    RAISE EXCEPTION 'spawned_invoice_id business (%) does not match delivery note business (%)',
      v_inv_biz, NEW.business_id
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_dn_spawned_invoice_business_match ON public.delivery_notes;
CREATE TRIGGER trg_dn_spawned_invoice_business_match
  BEFORE INSERT OR UPDATE OF spawned_invoice_id, business_id ON public.delivery_notes
  FOR EACH ROW EXECUTE FUNCTION public._dn_spawned_invoice_business_match();

-- 5. create_invoice_from_delivery_atomic ---------------------------------
--    Locks the DN, validates eligibility, copies lines, returns
--    { success, invoice_id, invoice_number }. Stamps both back-links.
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
    -- Idempotent: return the existing link.
    SELECT invoice_number INTO v_inv_number FROM public.invoices WHERE id = v_dn.spawned_invoice_id;
    RETURN jsonb_build_object(
      'success', true, 'invoice_id', v_dn.spawned_invoice_id,
      'invoice_number', v_inv_number, 'already_existed', true
    );
  END IF;
  IF v_dn.contact_id IS NULL THEN
    RAISE EXCEPTION 'Delivery note % has no customer — cannot raise an invoice', v_dn.delivery_number
      USING ERRCODE='22023';
  END IF;

  -- Every billable line (quantity_delivered > 0) must have a unit price.
  SELECT count(*) INTO v_missing_price
    FROM public.delivery_note_items
   WHERE delivery_note_id = p_dn_id
     AND quantity_delivered > 0
     AND (unit_price IS NULL);
  IF v_missing_price > 0 THEN
    RAISE EXCEPTION 'Cannot bill delivery %: % line(s) are missing a unit price', v_dn.delivery_number, v_missing_price
      USING ERRCODE='22023';
  END IF;

  -- Totals from delivered lines (recompute server-side; never trust client).
  SELECT
    COALESCE(SUM(quantity_delivered * unit_price * (1 - COALESCE(discount_percent,0)/100.0)), 0),
    COALESCE(SUM(COALESCE(tax_amount,0)), 0)
  INTO v_subtotal, v_tax_total
  FROM public.delivery_note_items
  WHERE delivery_note_id = p_dn_id AND quantity_delivered > 0;
  v_total := v_subtotal + v_tax_total;

  SELECT COALESCE(base_currency,'USD') INTO v_currency FROM public.businesses WHERE id = v_dn.business_id;
  SELECT public.get_next_invoice_number(v_dn.organization_id, v_dn.business_id) INTO v_inv_number;

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
     SET spawned_invoice_id = v_inv_id, updated_at = now()
   WHERE id = p_dn_id;

  RETURN jsonb_build_object(
    'success', true, 'invoice_id', v_inv_id,
    'invoice_number', v_inv_number, 'already_existed', false,
    'total', v_total
  );
END $$;

GRANT EXECUTE ON FUNCTION public.create_invoice_from_delivery_atomic(uuid, uuid) TO authenticated;

-- 6. complete_delivery_atomic: at the end of its transaction, invoke
--    the new RPC when the DN is eligible. Single transaction = true
--    atomicity (stock + COGS + invoice all-or-nothing).
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
  v_invoiced_qty numeric;
  v_sibling_delivered numeric;
  v_spawned jsonb;
  v_spawned_invoice_id uuid;
  v_spawned_invoice_number text;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'auth required' USING ERRCODE='42501'; END IF;

  IF p_received_by IS NOT NULL AND p_received_by ~ '^[0-9a-fA-F-]{36}$' THEN
    RAISE EXCEPTION 'p_received_by must be a recipient name, not a user id (got %). Pass the staff user id via p_received_by_user_id.', p_received_by
      USING ERRCODE='22023';
  END IF;
  v_received_by_clean := NULLIF(btrim(COALESCE(p_received_by, '')), '');

  SELECT id, organization_id, business_id, branch_id, sales_order_id, source_invoice_id,
         delivery_number, status, auto_invoice_on_complete, spawned_invoice_id, contact_id
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

  -- Per-product over-delivery cap when the DN traces back to an invoice.
  IF v_dn.source_invoice_id IS NOT NULL THEN
    FOR v_item IN
      SELECT dni.product_id, SUM(dni.quantity_delivered) AS qty
        FROM public.delivery_note_items dni
       WHERE dni.delivery_note_id = p_dn_id AND dni.quantity_delivered > 0
         AND dni.product_id IS NOT NULL
       GROUP BY dni.product_id
    LOOP
      SELECT COALESCE(SUM(ii.quantity), 0) INTO v_invoiced_qty
        FROM public.invoice_items ii
       WHERE ii.invoice_id = v_dn.source_invoice_id
         AND ii.product_id = v_item.product_id;

      SELECT COALESCE(SUM(sdni.quantity_delivered), 0) INTO v_sibling_delivered
        FROM public.delivery_notes sdn
        JOIN public.delivery_note_items sdni ON sdni.delivery_note_id = sdn.id
       WHERE sdn.source_invoice_id = v_dn.source_invoice_id
         AND sdn.id <> p_dn_id
         AND sdn.status IN ('delivered','partial')
         AND sdni.product_id = v_item.product_id;

      IF v_invoiced_qty > 0 AND (v_sibling_delivered + v_item.qty) > v_invoiced_qty THEN
        RAISE EXCEPTION
          'Over-delivery blocked: product % — invoiced %, already delivered %, attempting % more (would exceed invoice)',
          v_item.product_id, v_invoiced_qty, v_sibling_delivered, v_item.qty
          USING ERRCODE='22023';
      END IF;
    END LOOP;
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

  -- Auto-spawn invoice: only when DN is eligible (manually created,
  -- not yet billed). Runs inside the same transaction.
  IF COALESCE(v_dn.auto_invoice_on_complete, true)
     AND v_dn.source_invoice_id IS NULL
     AND v_dn.spawned_invoice_id IS NULL
     AND v_dn.contact_id IS NOT NULL
     AND EXISTS (
       SELECT 1 FROM public.delivery_note_items
        WHERE delivery_note_id = p_dn_id
          AND quantity_delivered > 0
          AND unit_price IS NOT NULL
     )
  THEN
    v_spawned := public.create_invoice_from_delivery_atomic(p_dn_id, p_user_id);
    v_spawned_invoice_id := (v_spawned->>'invoice_id')::uuid;
    v_spawned_invoice_number := v_spawned->>'invoice_number';
  END IF;

  PERFORM public._log_dn_event(p_dn_id, CASE WHEN v_is_partial THEN 'partially_delivered' ELSE 'delivered' END,
    p_user_id, v_received_by_clean,
    jsonb_build_object('movements', v_movement_count, 'cogs', v_total_cogs, 'pod_id', v_pod_id,
                       'spawned_invoice_id', v_spawned_invoice_id,
                       'spawned_invoice_number', v_spawned_invoice_number));

  RETURN jsonb_build_object(
    'success', true, 'delivery_id', p_dn_id, 'warehouse_id', v_warehouse_id,
    'movements_created', v_movement_count, 'gl_posted', v_journal_id IS NOT NULL,
    'cogs_total', v_total_cogs, 'pod_id', v_pod_id, 'partial', v_is_partial,
    'spawned_invoice_id', v_spawned_invoice_id,
    'spawned_invoice_number', v_spawned_invoice_number
  );
END $function$;

-- 7. Goods receipts: add structured received_by_user_id + backfill
--    any rows where a raw uuid was written into the free-text column.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
     WHERE table_schema='public' AND table_name='goods_receipts'
  ) THEN
    -- Add the structured column if missing.
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.columns
       WHERE table_schema='public' AND table_name='goods_receipts' AND column_name='received_by_user_id'
    ) THEN
      EXECUTE 'ALTER TABLE public.goods_receipts
               ADD COLUMN received_by_user_id uuid REFERENCES auth.users(id)';
      EXECUTE 'CREATE INDEX IF NOT EXISTS idx_goods_receipts_received_by_user_id
               ON public.goods_receipts(received_by_user_id)
               WHERE received_by_user_id IS NOT NULL';
    END IF;

    -- Backfill: if received_by is a uuid-typed column already, copy it across
    -- and null the source. If it's text-typed and contains a UUID string,
    -- parse + move it.
    IF EXISTS (
      SELECT 1 FROM information_schema.columns
       WHERE table_schema='public' AND table_name='goods_receipts'
         AND column_name='received_by' AND data_type='uuid'
    ) THEN
      EXECUTE 'UPDATE public.goods_receipts
                  SET received_by_user_id = received_by
                WHERE received_by IS NOT NULL AND received_by_user_id IS NULL';
      EXECUTE 'UPDATE public.goods_receipts SET received_by = NULL WHERE received_by IS NOT NULL';
    ELSIF EXISTS (
      SELECT 1 FROM information_schema.columns
       WHERE table_schema='public' AND table_name='goods_receipts'
         AND column_name='received_by' AND data_type IN ('text','character varying')
    ) THEN
      EXECUTE $bf$UPDATE public.goods_receipts
                     SET received_by_user_id = received_by::uuid
                   WHERE received_by_user_id IS NULL
                     AND received_by ~ '^[0-9a-fA-F-]{36}$'$bf$;
      EXECUTE $bf$UPDATE public.goods_receipts
                     SET received_by = NULL
                   WHERE received_by ~ '^[0-9a-fA-F-]{36}$'$bf$;
    END IF;
  END IF;
END $$;
