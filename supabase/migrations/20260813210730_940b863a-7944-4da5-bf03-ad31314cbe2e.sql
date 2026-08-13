-- Landed cost reporting reads. SECURITY INVOKER: existing RLS on
-- landed_cost_* and inventory_cost_revaluations remains the access boundary.

CREATE OR REPLACE FUNCTION public.landed_cost_receipt_summary(p_receipt_ids uuid[])
RETURNS TABLE (
  goods_receipt_id uuid,
  voucher_count integer,
  allocated_amount numeric,
  capitalized_amount numeric,
  expensed_amount numeric,
  posted_count integer,
  pending_count integer,
  currency text
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  SELECT a.goods_receipt_id,
         COUNT(DISTINCT a.voucher_id)::int,
         COALESCE(SUM(a.allocated_amount), 0),
         COALESCE(SUM(a.capitalized_amount), 0),
         COALESCE(SUM(a.expensed_amount), 0),
         COUNT(DISTINCT v.id) FILTER (WHERE v.status = 'posted')::int,
         COUNT(DISTINCT v.id) FILTER (WHERE v.status NOT IN ('posted', 'reversed', 'cancelled'))::int,
         MIN(v.currency)
    FROM public.landed_cost_allocations a
    JOIN public.landed_cost_vouchers v ON v.id = a.voucher_id
   WHERE a.goods_receipt_id = ANY(p_receipt_ids)
     AND v.status <> 'reversed'
   GROUP BY a.goods_receipt_id
$$;

COMMENT ON FUNCTION public.landed_cost_receipt_summary(uuid[]) IS
  'Per goods receipt landed cost rollup for procurement records. Read-only; no new source of truth.';

CREATE OR REPLACE FUNCTION public.landed_cost_valuation_attribution(
  p_business_id uuid,
  p_product_ids uuid[] DEFAULT NULL
)
RETURNS TABLE (
  product_id uuid,
  revaluation_count integer,
  uplift_amount numeric,
  unit_cost_before numeric,
  unit_cost_after numeric,
  last_applied_at timestamptz,
  last_voucher_id uuid
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  WITH r AS (
    SELECT *
      FROM public.inventory_cost_revaluations
     WHERE business_id = p_business_id
       AND source_type = 'landed_cost_voucher'
       AND reversed_at IS NULL
       AND (p_product_ids IS NULL OR product_id = ANY(p_product_ids))
  ),
  latest AS (
    SELECT DISTINCT ON (product_id)
           product_id, unit_cost_before, unit_cost_after, created_at, source_id
      FROM r
     ORDER BY product_id, created_at DESC
  )
  SELECT r.product_id,
         COUNT(*)::int,
         COALESCE(SUM(r.amount_applied), 0),
         l.unit_cost_before,
         l.unit_cost_after,
         l.created_at,
         l.source_id
    FROM r
    JOIN latest l ON l.product_id = r.product_id
   GROUP BY r.product_id, l.unit_cost_before, l.unit_cost_after, l.created_at, l.source_id
$$;

COMMENT ON FUNCTION public.landed_cost_valuation_attribution(uuid, uuid[]) IS
  'Landed cost uplift already applied to inventory value, per product, from inventory_cost_revaluations.';

CREATE OR REPLACE FUNCTION public.landed_cost_clearing_exposure(p_business_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_account uuid;
  v_balance numeric := 0;
  v_unposted numeric := 0;
  v_unposted_count integer := 0;
  v_currency text;
BEGIN
  v_account := public.resolve_posting_account(p_business_id, 'landed_cost_clearing', NULL);

  IF v_account IS NOT NULL THEN
    SELECT COALESCE(SUM(l.credit - l.debit), 0)
      INTO v_balance
      FROM public.journal_entry_lines l
      JOIN public.journal_entries j ON j.id = l.journal_entry_id
     WHERE l.account_id = v_account
       AND j.business_id = p_business_id
       AND j.status = 'posted';
  END IF;

  SELECT COALESCE(SUM(v.total_base_amount), 0), COUNT(*)::int, MIN(v.currency)
    INTO v_unposted, v_unposted_count, v_currency
    FROM public.landed_cost_vouchers v
   WHERE v.business_id = p_business_id
     AND v.status NOT IN ('posted', 'reversed', 'cancelled');

  RETURN jsonb_build_object(
    'clearing_account_id', v_account,
    'clearing_balance', v_balance,
    'unposted_amount', v_unposted,
    'unposted_count', v_unposted_count,
    'currency', v_currency);
END;
$$;

COMMENT ON FUNCTION public.landed_cost_clearing_exposure(uuid) IS
  'Landed cost clearing balance and unposted voucher exposure for period-close review.';

GRANT EXECUTE ON FUNCTION public.landed_cost_receipt_summary(uuid[]) TO authenticated;
GRANT EXECUTE ON FUNCTION public.landed_cost_valuation_attribution(uuid, uuid[]) TO authenticated;
GRANT EXECUTE ON FUNCTION public.landed_cost_clearing_exposure(uuid) TO authenticated;