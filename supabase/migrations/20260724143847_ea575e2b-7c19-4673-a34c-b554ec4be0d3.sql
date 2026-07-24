-- Phase 7 step 3 — Nightly auto-satisfy cron + recipient statement RPC
-- (pg_cron already installed; skip CREATE EXTENSION.)

DO $$
DECLARE
  jid bigint;
BEGIN
  SELECT jobid INTO jid FROM cron.job WHERE jobname = 'legal-orders-auto-satisfy-nightly';
  IF jid IS NOT NULL THEN
    PERFORM cron.unschedule(jid);
  END IF;
  PERFORM cron.schedule(
    'legal-orders-auto-satisfy-nightly',
    '15 2 * * *',
    $cron$SELECT public.legal_order_auto_satisfy(NULL);$cron$
  );
END $$;

CREATE OR REPLACE FUNCTION public.legal_order_recipient_statement(
  _organization_id uuid,
  _recipient_id    uuid,
  _from            date,
  _to              date
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_recipient jsonb;
  v_orders    jsonb;
  v_batches   jsonb;
  v_totals    jsonb;
BEGIN
  IF NOT public.user_has_organization_access(_organization_id) THEN
    RAISE EXCEPTION 'not_authorized_for_organization' USING ERRCODE = '42501';
  END IF;
  IF _from IS NULL OR _to IS NULL OR _to < _from THEN
    RAISE EXCEPTION 'invalid_period_range' USING ERRCODE = '22023';
  END IF;

  SELECT to_jsonb(r) - 'organization_id'
    INTO v_recipient
  FROM public.legal_recipients r
  WHERE r.id = _recipient_id
    AND r.organization_id = _organization_id;

  IF v_recipient IS NULL THEN
    RAISE EXCEPTION 'recipient_not_found' USING ERRCODE = 'P0002';
  END IF;

  WITH orders AS (
    SELECT lor.id                AS legal_order_id,
           lor.order_reference,
           lor.status,
           lor.employee_id,
           lor.total_owed,
           COALESCE(
             (SELECT SUM(gl.amount)
                FROM public.garnishment_ledger gl
               WHERE gl.legal_order_id = lor.id
                 AND gl.accrual_date BETWEEN _from AND _to), 0)         AS accrued_period,
           COALESCE(
             (SELECT SUM(rl.amount)
                FROM public.legal_order_remittance_lines rl
               WHERE rl.legal_order_id = lor.id
                 AND rl.payment_date BETWEEN _from AND _to), 0)          AS paid_period,
           COALESCE(
             (SELECT SUM(gl.amount)
                FROM public.garnishment_ledger gl
               WHERE gl.legal_order_id = lor.id), 0)                     AS accrued_to_date,
           COALESCE(
             (SELECT SUM(rl.amount)
                FROM public.legal_order_remittance_lines rl
               WHERE rl.legal_order_id = lor.id), 0)                     AS paid_to_date
      FROM public.legal_orders_records lor
     WHERE lor.organization_id = _organization_id
       AND lor.recipient_id    = _recipient_id
  )
  SELECT jsonb_agg(
           jsonb_build_object(
             'legal_order_id',   o.legal_order_id,
             'order_reference',  o.order_reference,
             'status',           o.status,
             'employee_id',      o.employee_id,
             'total_owed',       o.total_owed,
             'accrued_period',   o.accrued_period,
             'paid_period',      o.paid_period,
             'accrued_to_date',  o.accrued_to_date,
             'paid_to_date',     o.paid_to_date,
             'outstanding',      GREATEST(o.accrued_to_date - o.paid_to_date, 0)
           )
           ORDER BY o.order_reference NULLS LAST
         )
    INTO v_orders
  FROM orders o;

  SELECT jsonb_agg(
           jsonb_build_object(
             'batch_id',        b.id,
             'batch_number',    b.batch_number,
             'status',          b.status,
             'period_from',     b.period_from,
             'period_to',       b.period_to,
             'planned_total',   b.planned_total,
             'settled_at',      b.settled_at,
             'settled_payment_date', b.settled_payment_date,
             'settled_reference',    b.settled_reference,
             'bank_file_format',     b.bank_file_format,
             'bank_file_checksum',   b.bank_file_checksum
           )
           ORDER BY b.created_at DESC
         )
    INTO v_batches
  FROM public.legal_order_remittance_batches b
  WHERE b.organization_id = _organization_id
    AND b.recipient_id    = _recipient_id
    AND (b.period_from <= _to AND b.period_to >= _from);

  v_totals := jsonb_build_object(
    'accrued_period',  COALESCE((SELECT SUM((x->>'accrued_period')::numeric)  FROM jsonb_array_elements(COALESCE(v_orders,'[]'::jsonb)) x), 0),
    'paid_period',     COALESCE((SELECT SUM((x->>'paid_period')::numeric)     FROM jsonb_array_elements(COALESCE(v_orders,'[]'::jsonb)) x), 0),
    'outstanding',     COALESCE((SELECT SUM((x->>'outstanding')::numeric)     FROM jsonb_array_elements(COALESCE(v_orders,'[]'::jsonb)) x), 0),
    'accrued_to_date', COALESCE((SELECT SUM((x->>'accrued_to_date')::numeric) FROM jsonb_array_elements(COALESCE(v_orders,'[]'::jsonb)) x), 0),
    'paid_to_date',    COALESCE((SELECT SUM((x->>'paid_to_date')::numeric)    FROM jsonb_array_elements(COALESCE(v_orders,'[]'::jsonb)) x), 0)
  );

  RETURN jsonb_build_object(
    'generated_at',  now(),
    'organization_id', _organization_id,
    'period_from',   _from,
    'period_to',     _to,
    'recipient',     v_recipient,
    'orders',        COALESCE(v_orders,  '[]'::jsonb),
    'batches',       COALESCE(v_batches, '[]'::jsonb),
    'totals',        v_totals
  );
END;
$$;

REVOKE ALL ON FUNCTION public.legal_order_recipient_statement(uuid, uuid, date, date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.legal_order_recipient_statement(uuid, uuid, date, date) TO authenticated;