-- Sales Overview ("Sales Operations cockpit") reconciliation contract.
--
-- The dashboard is a PROJECTION, never a source of truth. These assertions
-- lock `get_sales_dashboard_kpis` to the canonical engines:
--   receivable + aging  -> finance_ar_net_position (base currency, credit-netted)
--   customer credit     -> finance_ar_customer_credit (via the net-position view)
--   cash applied        -> payment_allocations
--   orders to fulfil    -> so_line_balances
--
-- Run with an authenticated role that is a member of the org under test.

DO $$
DECLARE
  v_org      uuid;
  v_biz      uuid;
  v_kpi      jsonb;
  v_np_net   numeric;
  v_np_curr  numeric;
  v_np_30    numeric;
  v_np_60    numeric;
  v_np_90    numeric;
  v_np_nd    numeric;
  v_so_open  bigint;
  v_bucket_sum numeric;
BEGIN
  SELECT organization_id, business_id
  INTO v_org, v_biz
  FROM public.finance_ar_net_position
  LIMIT 1;

  IF v_org IS NULL THEN
    RAISE NOTICE 'no AR data in scope — skipping reconciliation test';
    RETURN;
  END IF;

  v_kpi := public.get_sales_dashboard_kpis(v_org, v_biz, NULL, NULL, NULL);

  SELECT COALESCE(SUM(net_amount),0), COALESCE(SUM(not_due),0),
         COALESCE(SUM(current_bucket),0), COALESCE(SUM(days30),0),
         COALESCE(SUM(days60),0), COALESCE(SUM(days90),0)
  INTO v_np_net, v_np_nd, v_np_curr, v_np_30, v_np_60, v_np_90
  FROM public.finance_ar_net_position
  WHERE organization_id = v_org AND business_id IS NOT DISTINCT FROM v_biz;

  -- 1. Receivable total equals the canonical net position.
  IF ABS((v_kpi->'receivable'->>'total')::numeric - v_np_net) > 0.01 THEN
    RAISE EXCEPTION 'receivable drift: dashboard % vs finance_ar_net_position %',
      v_kpi->'receivable'->>'total', v_np_net;
  END IF;

  -- 2. Every aging bucket matches the canonical projection verbatim.
  IF ABS((v_kpi->'aging'->>'not_due')::numeric - v_np_nd)  > 0.01
  OR ABS((v_kpi->'aging'->>'current')::numeric - v_np_curr) > 0.01
  OR ABS((v_kpi->'aging'->>'days30')::numeric  - v_np_30)  > 0.01
  OR ABS((v_kpi->'aging'->>'days60')::numeric  - v_np_60)  > 0.01
  OR ABS((v_kpi->'aging'->>'days90')::numeric  - v_np_90)  > 0.01 THEN
    RAISE EXCEPTION 'aging bucket drift vs finance_ar_net_position: %', v_kpi->'aging';
  END IF;

  -- 3. No bucket may be negative (the old code subtracted credit from `current`).
  IF (v_kpi->'aging'->>'current')::numeric < 0
  OR (v_kpi->'aging'->>'not_due')::numeric < 0 THEN
    RAISE EXCEPTION 'negative aging bucket: %', v_kpi->'aging';
  END IF;

  -- 4. Buckets tie back to gross open amount (credit is netted at total level).
  v_bucket_sum := (v_kpi->'aging'->>'not_due')::numeric
                + (v_kpi->'aging'->>'current')::numeric
                + (v_kpi->'aging'->>'days30')::numeric
                + (v_kpi->'aging'->>'days60')::numeric
                + (v_kpi->'aging'->>'days90')::numeric;
  IF ABS(v_bucket_sum - (v_kpi->'receivable'->>'open_amount')::numeric) > 0.01 THEN
    RAISE EXCEPTION 'aging buckets (%) do not sum to open amount (%)',
      v_bucket_sum, v_kpi->'receivable'->>'open_amount';
  END IF;

  -- 5. Orders to fulfil derive from open delivery quantities, not a status list.
  SELECT COUNT(DISTINCT sales_order_id)
  INTO v_so_open
  FROM public.so_line_balances
  WHERE organization_id = v_org
    AND business_id IS NOT DISTINCT FROM v_biz
    AND order_status NOT IN ('draft','cancelled')
    AND quantity_open_to_deliver > 0;

  IF (v_kpi->>'sales_orders_pending')::bigint <> COALESCE(v_so_open,0) THEN
    RAISE EXCEPTION 'orders-to-fulfil drift: dashboard % vs so_line_balances %',
      v_kpi->>'sales_orders_pending', v_so_open;
  END IF;

  -- 6. Cash applied never exceeds cash received in the period.
  IF (v_kpi->'payments'->>'applied')::numeric > (v_kpi->'payments'->>'total')::numeric + 0.01 THEN
    RAISE EXCEPTION 'applied cash exceeds received cash: %', v_kpi->'payments';
  END IF;

  RAISE NOTICE 'sales dashboard reconciliation OK';
END $$;
