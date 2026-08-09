-- ============================================================
-- Phase 7 — Settlement & refund completeness
-- ============================================================

-- Single, non-double-counted settlement position per sales return.
--   credited  = credit note total (the money owed back to the customer)
--   applied   = credited against open invoices
--   refunded  = paid out in cash / bank
--   open_credit = still sitting as unused customer credit
CREATE OR REPLACE VIEW public.v_sales_return_settlement AS
SELECT
  sr.id                                   AS sales_return_id,
  sr.organization_id,
  sr.business_id,
  sr.branch_id,
  sr.return_number,
  sr.status,
  cn.id                                   AS credit_note_id,
  cn.credit_note_number,
  cn.status                               AS credit_note_status,
  COALESCE(cn.total, 0)                   AS credited,
  COALESCE(cn.amount_applied, 0)          AS applied,
  COALESCE(cn.refund_amount, 0)           AS refunded,
  GREATEST(COALESCE(cn.total, 0)
           - COALESCE(cn.amount_applied, 0)
           - COALESCE(cn.refund_amount, 0), 0) AS open_credit,
  (cn.id IS NOT NULL
   AND cn.status IN ('issued','applied','refunded')
   AND COALESCE(cn.amount_applied, 0) + COALESCE(cn.refund_amount, 0)
       >= COALESCE(cn.total, 0) - 0.01)   AS is_settled
FROM public.sales_returns sr
LEFT JOIN public.credit_notes cn ON cn.id = sr.credit_note_id;

ALTER VIEW public.v_sales_return_settlement SET (security_invoker = on);
GRANT SELECT ON public.v_sales_return_settlement TO authenticated;

-- ------------------------------------------------------------
-- Lifecycle: 'refunded' now requires real settlement, not intent.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.transition_sales_return(
  _return_id uuid,
  _to_status text,
  _reason text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_sr public.sales_returns%ROWTYPE;
  v_cn public.credit_notes%ROWTYPE;
  v_settled numeric;
  v_allowed text[];
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'auth required' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_sr FROM public.sales_returns WHERE id = _return_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Sales return % not found', _return_id USING ERRCODE = '22023';
  END IF;
  IF NOT public.user_can_access_business(auth.uid(), v_sr.business_id) THEN
    RAISE EXCEPTION 'Access denied for business %', v_sr.business_id USING ERRCODE = '42501';
  END IF;

  IF v_sr.status = _to_status THEN
    RETURN jsonb_build_object('success', true, 'status', v_sr.status, 'changed', false);
  END IF;

  v_allowed := CASE v_sr.status
    WHEN 'pending'  THEN ARRAY['rejected']          -- 'approved' belongs to approve_sales_return_atomic
    WHEN 'approved' THEN ARRAY['received']
    WHEN 'received' THEN ARRAY['refunded']
    ELSE ARRAY[]::text[]
  END;

  IF _to_status = 'approved' THEN
    RAISE EXCEPTION 'approve a sales return through approve_sales_return_atomic, not a bare status change'
      USING ERRCODE = '22023';
  END IF;

  IF NOT (_to_status = ANY (v_allowed)) THEN
    RAISE EXCEPTION 'sales return cannot move from % to %', v_sr.status, _to_status
      USING ERRCODE = '22023';
  END IF;

  -- Phase 7 — the status must never run ahead of the money.
  IF _to_status = 'refunded' THEN
    IF v_sr.credit_note_id IS NULL THEN
      RAISE EXCEPTION 'sales return % has no credit note — it cannot be marked refunded', v_sr.return_number
        USING ERRCODE = '22023',
        HINT = 'approve the return first so the credit note is raised';
    END IF;

    SELECT * INTO v_cn FROM public.credit_notes WHERE id = v_sr.credit_note_id FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'credit note for sales return % not found', v_sr.return_number USING ERRCODE = '22023';
    END IF;
    IF v_cn.status NOT IN ('issued','applied','refunded') THEN
      RAISE EXCEPTION 'credit note % is still % — issue it before settling the return',
        v_cn.credit_note_number, v_cn.status
        USING ERRCODE = '22023';
    END IF;

    v_settled := COALESCE(v_cn.amount_applied, 0) + COALESCE(v_cn.refund_amount, 0);
    IF v_settled < COALESCE(v_cn.total, 0) - 0.01 THEN
      RAISE EXCEPTION
        'sales return % is only settled for % of % — apply the credit or record the refund first',
        v_sr.return_number, v_settled, COALESCE(v_cn.total, 0)
        USING ERRCODE = '22023',
        HINT = 'apply the credit note to an invoice or process the customer refund';
    END IF;
  END IF;

  UPDATE public.sales_returns
     SET status = _to_status,
         notes = CASE WHEN _reason IS NULL OR _reason = '' THEN notes
                      ELSE COALESCE(notes || E'\n', '') || _to_status || ': ' || _reason END,
         updated_at = now()
   WHERE id = _return_id;

  RETURN jsonb_build_object('success', true, 'status', _to_status, 'changed', true);
END;
$function$;

REVOKE ALL ON FUNCTION public.transition_sales_return(uuid, text, text) FROM public;
GRANT EXECUTE ON FUNCTION public.transition_sales_return(uuid, text, text) TO authenticated;