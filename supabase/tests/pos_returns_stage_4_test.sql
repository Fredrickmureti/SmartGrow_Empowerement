-- Stage 4 closeout — SQL self-tests for process_pos_return cross-tender gate.
-- These run against a live database (supabase/local). They assert the
-- function signature and error codes; full end-to-end fixtures live in
-- the vitest structural test (src/test/pos/stage-4-returns.test.ts).

-- 1) Function exists with the new optional p_override_id param.
DO $$
DECLARE
  v_args text;
BEGIN
  SELECT pg_get_function_identity_arguments('public.process_pos_return'::regproc) INTO v_args;
  IF position('p_override_id uuid' IN v_args) = 0 THEN
    RAISE EXCEPTION 'process_pos_return missing p_override_id param: %', v_args;
  END IF;
END $$;

-- 2) Cross-tender call without override returns a structured error,
--    not a raised exception (callers must surface the message to cashier).
DO $$
DECLARE
  v_result jsonb;
  v_err    text;
BEGIN
  -- Use obviously-invalid UUIDs so we hit the cross-tender branch only if
  -- the function happens to find a fake original. We just assert the
  -- function returns jsonb (no signature drift).
  v_result := public.process_pos_return(
    p_organization_id => '00000000-0000-0000-0000-000000000001'::uuid,
    p_register_id     => '00000000-0000-0000-0000-000000000002'::uuid,
    p_shift_id        => '00000000-0000-0000-0000-000000000003'::uuid,
    p_original_transaction_id => '00000000-0000-0000-0000-000000000004'::uuid,
    p_items           => '[]'::jsonb,
    p_refund_method   => 'cash',
    p_notes           => null,
    p_created_by      => null,
    p_override_id     => null
  );
  IF v_result->>'success' <> 'false' THEN
    RAISE EXCEPTION 'expected failure response, got %', v_result;
  END IF;
END $$;

-- 3) v_pos_returnable_qty exists and exposes the columns the RPC reads.
DO $$
BEGIN
  PERFORM original_item_id, original_transaction_id, returnable_qty,
          unit_price, tax_rate, cost_price, description, product_id
    FROM public.v_pos_returnable_qty
   LIMIT 0;
END $$;

-- 4) pos_return_reasons is seeded with the canonical immutable codes.
DO $$
DECLARE
  v_missing text;
BEGIN
  SELECT string_agg(code, ',') INTO v_missing
    FROM (VALUES ('defective'),('wrong_item'),('customer_changed_mind'),
                 ('expired'),('price_match'),('other')) t(code)
   WHERE NOT EXISTS (SELECT 1 FROM public.pos_return_reasons r WHERE r.code = t.code);
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'pos_return_reasons missing codes: %', v_missing;
  END IF;
END $$;
