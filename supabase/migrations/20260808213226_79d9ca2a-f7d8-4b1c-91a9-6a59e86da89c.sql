CREATE OR REPLACE FUNCTION public.resolve_credit_note_revenue_lines(
  p_credit_note_id uuid,
  p_org_id uuid,
  p_business_id uuid,
  p_subtotal numeric,
  p_cn_number text
) RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_fallback uuid;
  v_lines jsonb := '[]'::jsonb;
  v_buckets jsonb;
  v_line_sum numeric := 0;
  v_alloc numeric := 0;
  v_amount numeric;
  v_count int := 0;
  v_idx int := 0;
  v_b jsonb;
BEGIN
  v_fallback := public.compensation_account(p_business_id, 'sales_revenue');
  IF COALESCE(p_subtotal, 0) <= 0 THEN
    RETURN '[]'::jsonb;
  END IF;

  SELECT COALESCE(SUM(COALESCE(line_total, 0)), 0)
    INTO v_line_sum
    FROM public.credit_note_items WHERE credit_note_id = p_credit_note_id;

  IF v_line_sum > 0 THEN
    SELECT COALESCE(jsonb_agg(jsonb_build_object('acct', acct, 'weight', w) ORDER BY acct), '[]'::jsonb)
      INTO v_buckets
      FROM (
        SELECT acct, SUM(w) AS w FROM (
          SELECT COALESCE(
                   public.resolve_product_gl_account(p_org_id, p_business_id, cni.product_id, 'sales_revenue'),
                   v_fallback) AS acct,
                 COALESCE(cni.line_total, 0) AS w
            FROM public.credit_note_items cni
           WHERE cni.credit_note_id = p_credit_note_id
        ) s
        WHERE s.acct IS NOT NULL AND s.w > 0
        GROUP BY acct
      ) g;
  ELSE
    v_buckets := '[]'::jsonb;
  END IF;

  v_count := jsonb_array_length(v_buckets);

  -- No usable line detail: keep the legacy single-account behaviour.
  IF v_count = 0 THEN
    IF v_fallback IS NULL THEN RETURN '[]'::jsonb; END IF;
    RETURN jsonb_build_array(
      jsonb_build_object('account_id', v_fallback, 'debit', p_subtotal, 'credit', 0,
        'description', 'Credit Note ' || p_cn_number || ' — revenue reversal'));
  END IF;

  -- Header subtotal is authoritative; residual lands on the last bucket.
  FOR v_idx IN 0 .. v_count - 1 LOOP
    v_b := v_buckets -> v_idx;
    IF v_idx = v_count - 1 THEN
      v_amount := ROUND(p_subtotal - v_alloc, 2);
    ELSE
      v_amount := ROUND(p_subtotal * ((v_b ->> 'weight')::numeric / v_line_sum), 2);
      v_alloc := v_alloc + v_amount;
    END IF;
    IF v_amount <> 0 THEN
      v_lines := v_lines || jsonb_build_array(
        jsonb_build_object('account_id', (v_b ->> 'acct')::uuid, 'debit', v_amount, 'credit', 0,
          'description', 'Credit Note ' || p_cn_number || ' — revenue reversal'));
    END IF;
  END LOOP;

  RETURN v_lines;
END $function$;

REVOKE ALL ON FUNCTION public.resolve_credit_note_revenue_lines(uuid, uuid, uuid, numeric, text) FROM public;
GRANT EXECUTE ON FUNCTION public.resolve_credit_note_revenue_lines(uuid, uuid, uuid, numeric, text) TO authenticated, service_role;