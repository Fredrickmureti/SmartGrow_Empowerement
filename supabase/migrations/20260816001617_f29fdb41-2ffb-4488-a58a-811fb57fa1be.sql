-- =====================================================================
-- POS Wave · Phase 5 — server-side money authority for table orders
-- =====================================================================
-- The restaurant path (useTableOrder) mutated pos_transaction_items and
-- pos_transactions money columns straight from the browser: unit_price,
-- tax_rate, tax_amount, line_total, subtotal and total were all computed
-- in JS. Retail already routes through pos_quote_cart / pos_resolve_line.
-- This RPC gives table orders the same single pricing authority.
--
-- Contract: the client sends INTENT (product, quantity, packaging,
-- approved discount, description). The server returns MONEY.
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
  v_txn        record;
  v_quote      jsonb;
  v_line       jsonb;
  v_idx        integer := 0;
  v_new_version integer;
BEGIN
  SELECT id, organization_id, business_id, branch_id, register_id, status,
         version, table_session_id
    INTO v_txn
    FROM public.pos_transactions
   WHERE id = p_transaction_id
   FOR UPDATE;

  IF v_txn.id IS NULL THEN
    RAISE EXCEPTION 'table order % not found', p_transaction_id
      USING ERRCODE = 'no_data_found';
  END IF;

  PERFORM public.assert_pos_caller_branch_access(v_txn.branch_id);

  -- Only an open/draft bill may be re-priced. Completed, voided or
  -- refunded transactions are financial records, not carts.
  IF COALESCE(v_txn.status, '') NOT IN ('draft', 'open', 'held', 'pending') THEN
    RAISE EXCEPTION 'table order % is % and can no longer be edited',
      p_transaction_id, v_txn.status
      USING ERRCODE = 'check_violation';
  END IF;

  -- Optimistic concurrency: another terminal wins, this caller refreshes.
  IF p_expected_version IS NOT NULL
     AND COALESCE(v_txn.version, 1) <> p_expected_version THEN
    RETURN jsonb_build_object(
      'success', false,
      'conflict', true,
      'current_version', COALESCE(v_txn.version, 1));
  END IF;

  -- ---- Single pricing authority -------------------------------------
  v_quote := public.pos_quote_cart(
    v_txn.register_id,
    COALESCE(p_lines, '[]'::jsonb),
    p_contact_id,
    p_cart_discount_type,
    COALESCE(p_cart_discount_value, 0));

  -- ---- Replace the line set with the quoted (server-priced) lines ----
  DELETE FROM public.pos_transaction_items WHERE transaction_id = v_txn.id;

  FOR v_line IN
    SELECT * FROM jsonb_array_elements(COALESCE(v_quote->'lines', '[]'::jsonb))
  LOOP
    INSERT INTO public.pos_transaction_items (
      transaction_id, organization_id, business_id, branch_id,
      product_id, description, quantity,
      unit_price, discount_type, discount_value,
      tax_rate, tax_amount, tax_rate_id, line_total,
      cost_price, sort_order,
      packaging_id, display_uom_id, display_quantity
    )
    SELECT
      v_txn.id, v_txn.organization_id, v_txn.business_id, v_txn.branch_id,
      NULLIF(v_line->>'product_id','')::uuid,
      COALESCE(NULLIF(src->>'description',''), 'Item'),
      COALESCE((v_line->>'quantity')::numeric, 0),
      COALESCE((v_line->>'unit_price')::numeric, 0),
      NULLIF(src->>'discount_type',''),
      COALESCE((src->>'discount_value')::numeric, 0),
      COALESCE((v_line->>'tax_rate')::numeric, 0),
      COALESCE((v_line->>'tax_amount')::numeric, 0),
      NULLIF(v_line->>'tax_rate_id','')::uuid,
      COALESCE((v_line->>'line_total')::numeric, 0),
      COALESCE((src->>'cost_price')::numeric, 0),
      v_idx,
      NULLIF(src->>'packaging_id','')::uuid,
      NULLIF(src->>'display_uom_id','')::uuid,
      NULLIF(src->>'display_quantity','')::numeric
    FROM (
      SELECT l AS src
        FROM jsonb_array_elements(COALESCE(p_lines, '[]'::jsonb)) l
       WHERE COALESCE(l->>'line_id','') = COALESCE(v_line->>'line_id','')
       LIMIT 1
    ) m;

    v_idx := v_idx + 1;
  END LOOP;

  -- ---- Money columns come from the quote, never from the client ------
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
    'success', true,
    'conflict', false,
    'transaction_id', v_txn.id,
    'version', v_new_version,
    'quote', v_quote);
END
$function$;

REVOKE ALL ON FUNCTION public.pos_sync_table_order(uuid, jsonb, integer, text, numeric, uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.pos_sync_table_order(uuid, jsonb, integer, text, numeric, uuid, text) FROM anon;
GRANT EXECUTE ON FUNCTION public.pos_sync_table_order(uuid, jsonb, integer, text, numeric, uuid, text) TO authenticated, service_role;

COMMENT ON FUNCTION public.pos_sync_table_order(uuid, jsonb, integer, text, numeric, uuid, text) IS
'POS Phase 5: single write path for open restaurant table orders. Client sends line intent only; all prices, tax and totals are derived server-side via pos_quote_cart. Optimistic-concurrency guarded on pos_transactions.version.';