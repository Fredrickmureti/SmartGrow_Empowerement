-- POS Wave · Phase 5 (fix) — preserve line identity across table-order saves.
-- The first cut replaced the whole item set on every save. pos_kitchen_orders
-- stores transaction_item_id (no FK), so a wipe-and-reinsert orphaned every
-- kitchen/bar ticket already fired for the table. Saves are now a diff:
-- update known line ids, insert new ones, delete only what the waiter removed.
CREATE OR REPLACE FUNCTION public.pos_sync_table_order(
  p_transaction_id uuid,
  p_lines jsonb,
  p_expected_version integer,
  p_cart_discount_type text DEFAULT NULL,
  p_cart_discount_value numeric DEFAULT 0,
  p_contact_id uuid DEFAULT NULL,
  p_notes text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_txn         record;
  v_quote       jsonb;
  v_line        jsonb;
  v_src         jsonb;
  v_idx         integer := 0;
  v_line_id     uuid;
  v_kept        uuid[] := ARRAY[]::uuid[];
  v_new_version integer;
BEGIN
  SELECT id, organization_id, business_id, branch_id, register_id, status, version
    INTO v_txn
    FROM public.pos_transactions
   WHERE id = p_transaction_id
   FOR UPDATE;

  IF v_txn.id IS NULL THEN
    RAISE EXCEPTION 'table order % not found', p_transaction_id
      USING ERRCODE = 'no_data_found';
  END IF;

  PERFORM public.assert_pos_caller_branch_access(v_txn.branch_id);

  IF COALESCE(v_txn.status, '') NOT IN ('draft', 'open', 'held', 'pending') THEN
    RAISE EXCEPTION 'table order % is % and can no longer be edited',
      p_transaction_id, v_txn.status
      USING ERRCODE = 'check_violation';
  END IF;

  IF p_expected_version IS NOT NULL
     AND COALESCE(v_txn.version, 1) <> p_expected_version THEN
    RETURN jsonb_build_object(
      'success', false, 'conflict', true,
      'current_version', COALESCE(v_txn.version, 1));
  END IF;

  -- Single pricing authority (same resolver retail checkout uses).
  v_quote := public.pos_quote_cart(
    v_txn.register_id,
    COALESCE(p_lines, '[]'::jsonb),
    p_contact_id,
    p_cart_discount_type,
    COALESCE(p_cart_discount_value, 0));

  FOR v_line IN
    SELECT * FROM jsonb_array_elements(COALESCE(v_quote->'lines', '[]'::jsonb))
  LOOP
    SELECT l INTO v_src
      FROM jsonb_array_elements(COALESCE(p_lines, '[]'::jsonb)) l
     WHERE COALESCE(l->>'line_id','') = COALESCE(v_line->>'line_id','')
     LIMIT 1;

    v_line_id := NULLIF(v_line->>'line_id','')::uuid;

    IF v_line_id IS NOT NULL AND EXISTS (
      SELECT 1 FROM public.pos_transaction_items
       WHERE id = v_line_id AND transaction_id = v_txn.id
    ) THEN
      UPDATE public.pos_transaction_items
         SET product_id      = NULLIF(v_line->>'product_id','')::uuid,
             description     = COALESCE(NULLIF(v_src->>'description',''), description),
             quantity        = COALESCE((v_line->>'quantity')::numeric, 0),
             unit_price      = COALESCE((v_line->>'unit_price')::numeric, 0),
             discount_type   = NULLIF(v_src->>'discount_type',''),
             discount_value  = COALESCE((v_src->>'discount_value')::numeric, 0),
             tax_rate        = COALESCE((v_line->>'tax_rate')::numeric, 0),
             tax_amount      = COALESCE((v_line->>'tax_amount')::numeric, 0),
             tax_rate_id     = NULLIF(v_line->>'tax_rate_id','')::uuid,
             line_total      = COALESCE((v_line->>'line_total')::numeric, 0),
             sort_order      = v_idx,
             packaging_id    = NULLIF(v_src->>'packaging_id','')::uuid,
             display_uom_id  = NULLIF(v_src->>'display_uom_id','')::uuid,
             display_quantity = NULLIF(v_src->>'display_quantity','')::numeric
       WHERE id = v_line_id;
    ELSE
      INSERT INTO public.pos_transaction_items (
        transaction_id, organization_id, business_id, branch_id,
        product_id, description, quantity,
        unit_price, discount_type, discount_value,
        tax_rate, tax_amount, tax_rate_id, line_total,
        cost_price, sort_order,
        packaging_id, display_uom_id, display_quantity, etims_tax_code
      ) VALUES (
        v_txn.id, v_txn.organization_id, v_txn.business_id, v_txn.branch_id,
        NULLIF(v_line->>'product_id','')::uuid,
        COALESCE(NULLIF(v_src->>'description',''), 'Item'),
        COALESCE((v_line->>'quantity')::numeric, 0),
        COALESCE((v_line->>'unit_price')::numeric, 0),
        NULLIF(v_src->>'discount_type',''),
        COALESCE((v_src->>'discount_value')::numeric, 0),
        COALESCE((v_line->>'tax_rate')::numeric, 0),
        COALESCE((v_line->>'tax_amount')::numeric, 0),
        NULLIF(v_line->>'tax_rate_id','')::uuid,
        COALESCE((v_line->>'line_total')::numeric, 0),
        COALESCE((v_src->>'cost_price')::numeric, 0),
        v_idx,
        NULLIF(v_src->>'packaging_id','')::uuid,
        NULLIF(v_src->>'display_uom_id','')::uuid,
        NULLIF(v_src->>'display_quantity','')::numeric,
        NULLIF(v_src->>'etims_tax_code','')
      )
      RETURNING id INTO v_line_id;
    END IF;

    v_kept := array_append(v_kept, v_line_id);
    v_idx := v_idx + 1;
  END LOOP;

  -- Only lines the caller actually dropped are removed.
  DELETE FROM public.pos_transaction_items
   WHERE transaction_id = v_txn.id
     AND NOT (id = ANY (v_kept));

  v_new_version := COALESCE(v_txn.version, 1) + 1;

  UPDATE public.pos_transactions
     SET subtotal        = COALESCE((v_quote->>'subtotal')::numeric, 0),
         discount_amount = COALESCE((v_quote->>'discount_amount')::numeric, 0),
         tax_amount      = COALESCE((v_quote->>'tax_amount')::numeric, 0),
         total           = COALESCE((v_quote->>'total')::numeric, 0),
         customer_id     = COALESCE(p_contact_id, customer_id),
         notes           = COALESCE(p_notes, notes),
         version         = v_new_version,
         updated_at      = now()
   WHERE id = v_txn.id;

  RETURN jsonb_build_object(
    'success', true, 'conflict', false,
    'transaction_id', v_txn.id,
    'version', v_new_version,
    'line_ids', to_jsonb(v_kept),
    'quote', v_quote);
END
$function$;

REVOKE ALL ON FUNCTION public.pos_sync_table_order(uuid, jsonb, integer, text, numeric, uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.pos_sync_table_order(uuid, jsonb, integer, text, numeric, uuid, text) FROM anon;
GRANT EXECUTE ON FUNCTION public.pos_sync_table_order(uuid, jsonb, integer, text, numeric, uuid, text) TO authenticated, service_role;