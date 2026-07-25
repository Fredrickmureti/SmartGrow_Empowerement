
-- 1. Rebuild Phase-7 RPCs with the correct membership helper name --------

CREATE OR REPLACE FUNCTION public.legal_order_build_remittance_batch(
  p_organization_id uuid,
  p_business_id     uuid,
  p_recipient_id    uuid,
  p_period_from     date,
  p_period_to       date,
  p_notes           text DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_batch_id     uuid;
  v_batch_number text;
  v_seq          integer;
  v_planned      numeric(14,2) := 0;
  v_lines        integer := 0;
  v_recipient    public.legal_recipients%ROWTYPE;
BEGIN
  IF NOT public.user_belongs_to_org(p_organization_id) THEN
    RAISE EXCEPTION 'ORG_ACCESS_DENIED' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_recipient
    FROM public.legal_recipients
   WHERE id = p_recipient_id AND organization_id = p_organization_id;
  IF v_recipient.id IS NULL THEN
    RAISE EXCEPTION 'RECIPIENT_NOT_FOUND' USING ERRCODE = '22023';
  END IF;

  IF p_period_to < p_period_from THEN
    RAISE EXCEPTION 'INVALID_PERIOD' USING ERRCODE = '22023';
  END IF;

  SELECT COALESCE(MAX(
      NULLIF(regexp_replace(batch_number, '^LORB-\d{4}-', ''), '')::integer
    ), 0) + 1
    INTO v_seq
    FROM public.legal_order_remittance_batches
   WHERE organization_id = p_organization_id
     AND batch_number ~ ('^LORB-' || to_char(now(),'YYYY') || '-\d+$');
  v_batch_number := 'LORB-' || to_char(now(),'YYYY') || '-' || lpad(v_seq::text, 6, '0');

  INSERT INTO public.legal_order_remittance_batches (
    organization_id, business_id, recipient_id, batch_number,
    status, period_from, period_to, payment_method_id, notes, created_by
  ) VALUES (
    p_organization_id, p_business_id, p_recipient_id, v_batch_number,
    'draft', p_period_from, p_period_to, v_recipient.default_payment_method_id, p_notes, auth.uid()
  )
  RETURNING id INTO v_batch_id;

  WITH accrued AS (
    SELECT gl.garnishment_id, lor.employee_id, SUM(gl.amount) AS amt
      FROM public.garnishment_ledger gl
      JOIN public.legal_orders_records lor ON lor.id = gl.garnishment_id
     WHERE lor.recipient_id = p_recipient_id
       AND lor.organization_id = p_organization_id
       AND (p_business_id IS NULL OR lor.business_id = p_business_id)
       AND gl.payment_date BETWEEN p_period_from AND p_period_to
     GROUP BY gl.garnishment_id, lor.employee_id
  ),
  paid AS (
    SELECT rl.garnishment_id, SUM(rl.amount) AS amt
      FROM public.legal_order_remittance_lines rl
      JOIN public.legal_orders_records lor ON lor.id = rl.garnishment_id
     WHERE lor.recipient_id = p_recipient_id
       AND rl.organization_id = p_organization_id
       AND rl.payment_date BETWEEN p_period_from AND p_period_to
     GROUP BY rl.garnishment_id
  ),
  pending AS (
    SELECT a.garnishment_id, a.employee_id,
           GREATEST(a.amt - COALESCE(p.amt, 0), 0)::numeric(14,2) AS planned
      FROM accrued a LEFT JOIN paid p USING (garnishment_id)
     WHERE GREATEST(a.amt - COALESCE(p.amt, 0), 0) > 0
  )
  INSERT INTO public.legal_order_remittance_batch_lines
    (batch_id, organization_id, garnishment_id, employee_id, planned_amount)
  SELECT v_batch_id, p_organization_id, garnishment_id, employee_id, planned
    FROM pending;

  SELECT COALESCE(SUM(planned_amount),0), COUNT(*)
    INTO v_planned, v_lines
    FROM public.legal_order_remittance_batch_lines
   WHERE batch_id = v_batch_id;

  UPDATE public.legal_order_remittance_batches
     SET planned_total = v_planned, planned_line_count = v_lines
   WHERE id = v_batch_id;

  IF v_lines = 0 THEN
    UPDATE public.legal_order_remittance_batches
       SET status = 'cancelled',
           cancelled_at = now(),
           cancelled_reason = 'no_pending_accruals'
     WHERE id = v_batch_id;
  END IF;

  RETURN v_batch_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.legal_order_generate_remittance_bank_file(
  p_batch_id uuid,
  p_format   text DEFAULT 'csv'
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_batch     public.legal_order_remittance_batches%ROWTYPE;
  v_body      text;
  v_checksum  text;
  v_recipient public.legal_recipients%ROWTYPE;
BEGIN
  SELECT * INTO v_batch FROM public.legal_order_remittance_batches WHERE id = p_batch_id;
  IF v_batch.id IS NULL THEN
    RAISE EXCEPTION 'BATCH_NOT_FOUND' USING ERRCODE = '22023';
  END IF;
  IF NOT public.user_belongs_to_org(v_batch.organization_id) THEN
    RAISE EXCEPTION 'ORG_ACCESS_DENIED' USING ERRCODE = '42501';
  END IF;
  IF v_batch.status NOT IN ('draft','generated') THEN
    RAISE EXCEPTION 'BATCH_NOT_GENERABLE:%', v_batch.status USING ERRCODE = '22023';
  END IF;
  IF v_batch.planned_line_count = 0 THEN
    RAISE EXCEPTION 'BATCH_EMPTY' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_recipient FROM public.legal_recipients WHERE id = v_batch.recipient_id;

  IF p_format = 'csv' THEN
    SELECT string_agg(row_text, E'\n')
      INTO v_body
    FROM (
      SELECT 'garnishment_id,case_reference,employee_id,amount,reference' AS row_text, 0 AS ord
      UNION ALL
      SELECT
        bl.garnishment_id::text
          || ',' || COALESCE(lor.case_reference,'')
          || ',' || COALESCE(bl.employee_id::text,'')
          || ',' || to_char(bl.planned_amount, 'FM999999999999990.00')
          || ',' || COALESCE(v_batch.batch_number,''),
        1
      FROM public.legal_order_remittance_batch_lines bl
      JOIN public.legal_orders_records lor ON lor.id = bl.garnishment_id
      WHERE bl.batch_id = v_batch.id
    ) s;
  ELSIF p_format = 'ach_stub' THEN
    v_body := format('ACH-STUB|%s|%s|%s|%s',
      v_batch.batch_number,
      COALESCE(v_recipient.display_name,'RECIPIENT'),
      to_char(v_batch.planned_total, 'FM999999999999990.00'),
      v_batch.planned_line_count);
  ELSIF p_format = 'sepa_pain001_stub' THEN
    v_body := format('PAIN.001-STUB|%s|%s|%s|%s',
      v_batch.batch_number,
      COALESCE(v_recipient.display_name,'RECIPIENT'),
      to_char(v_batch.planned_total, 'FM999999999999990.00'),
      v_batch.planned_line_count);
  ELSE
    RAISE EXCEPTION 'UNSUPPORTED_FORMAT:%', p_format USING ERRCODE = '22023';
  END IF;

  v_checksum := encode(digest(v_body, 'sha256'), 'hex');

  UPDATE public.legal_order_remittance_batches
     SET status = 'generated',
         bank_file_format = p_format,
         bank_file_checksum = v_checksum,
         bank_file_generated_at = now()
   WHERE id = v_batch.id;

  RETURN jsonb_build_object(
    'batch_id', v_batch.id,
    'batch_number', v_batch.batch_number,
    'format', p_format,
    'checksum', v_checksum,
    'byte_size', length(v_body),
    'body', v_body,
    'planned_total', v_batch.planned_total,
    'line_count', v_batch.planned_line_count
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.legal_order_settle_remittance_batch(
  p_batch_id uuid,
  p_payment_date date,
  p_reference text DEFAULT NULL,
  p_bank_transaction_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_batch   public.legal_order_remittance_batches%ROWTYPE;
  v_line    RECORD;
  v_rl_id   uuid;
  v_evt     uuid;
  v_pay_id  uuid;
  v_settled_lines integer := 0;
  v_settled_total numeric(14,2) := 0;
BEGIN
  SELECT * INTO v_batch FROM public.legal_order_remittance_batches WHERE id = p_batch_id FOR UPDATE;
  IF v_batch.id IS NULL THEN
    RAISE EXCEPTION 'BATCH_NOT_FOUND' USING ERRCODE = '22023';
  END IF;
  IF NOT public.user_belongs_to_org(v_batch.organization_id) THEN
    RAISE EXCEPTION 'ORG_ACCESS_DENIED' USING ERRCODE = '42501';
  END IF;
  IF v_batch.status <> 'generated' THEN
    RAISE EXCEPTION 'BATCH_NOT_GENERATED:%', v_batch.status USING ERRCODE = '22023';
  END IF;
  IF v_batch.bank_file_checksum IS NULL THEN
    RAISE EXCEPTION 'BANK_FILE_MISSING' USING ERRCODE = '22023';
  END IF;

  v_pay_id := gen_random_uuid();

  FOR v_line IN
    SELECT bl.*, lor.employee_id AS lor_employee_id
      FROM public.legal_order_remittance_batch_lines bl
      JOIN public.legal_orders_records lor ON lor.id = bl.garnishment_id
     WHERE bl.batch_id = v_batch.id
       AND bl.planned_amount > 0
  LOOP
    v_evt := gen_random_uuid();

    INSERT INTO public.legal_order_remittance_lines (
      organization_id, business_id, garnishment_id, payment_id, source_event_id,
      amount, reference_number, payment_date, actor_user_id
    ) VALUES (
      v_batch.organization_id, v_batch.business_id, v_line.garnishment_id,
      v_pay_id, v_evt,
      v_line.planned_amount,
      COALESCE(p_reference, v_batch.batch_number),
      p_payment_date,
      auth.uid()
    )
    RETURNING id INTO v_rl_id;

    UPDATE public.legal_order_remittance_batch_lines
       SET actual_amount = v_line.planned_amount,
           remittance_line_id = v_rl_id,
           reference_number = COALESCE(p_reference, v_batch.batch_number)
     WHERE id = v_line.id;

    v_settled_lines := v_settled_lines + 1;
    v_settled_total := v_settled_total + v_line.planned_amount;
  END LOOP;

  UPDATE public.legal_order_remittance_batches
     SET status = 'settled',
         settled_at = now(),
         settled_payment_date = p_payment_date,
         settled_reference = COALESCE(p_reference, v_batch.batch_number),
         settled_bank_transaction_id = p_bank_transaction_id
   WHERE id = v_batch.id;

  PERFORM public.legal_order_auto_satisfy(v_batch.organization_id);

  RETURN jsonb_build_object(
    'batch_id', v_batch.id,
    'settled_lines', v_settled_lines,
    'settled_total', v_settled_total,
    'payment_id', v_pay_id
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.legal_order_cancel_remittance_batch(
  p_batch_id uuid,
  p_reason   text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_batch public.legal_order_remittance_batches%ROWTYPE;
BEGIN
  SELECT * INTO v_batch FROM public.legal_order_remittance_batches WHERE id = p_batch_id FOR UPDATE;
  IF v_batch.id IS NULL THEN
    RAISE EXCEPTION 'BATCH_NOT_FOUND' USING ERRCODE = '22023';
  END IF;
  IF NOT public.user_belongs_to_org(v_batch.organization_id) THEN
    RAISE EXCEPTION 'ORG_ACCESS_DENIED' USING ERRCODE = '42501';
  END IF;
  IF v_batch.status = 'settled' THEN
    RAISE EXCEPTION 'BATCH_ALREADY_SETTLED' USING ERRCODE = '22023';
  END IF;
  IF v_batch.status = 'cancelled' THEN RETURN; END IF;

  UPDATE public.legal_order_remittance_batches
     SET status = 'cancelled',
         cancelled_at = now(),
         cancelled_reason = COALESCE(p_reason, 'manual_cancel')
   WHERE id = p_batch_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.legal_order_match_batch_to_bank_txn(
  _batch_id uuid,
  _bank_transaction_id uuid
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_batch    public.legal_order_remittance_batches%ROWTYPE;
  v_txn      public.bank_transactions%ROWTYPE;
  v_match_id uuid;
  v_actor    uuid := auth.uid();
BEGIN
  SELECT * INTO v_batch FROM public.legal_order_remittance_batches WHERE id = _batch_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'BATCH_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;
  IF v_batch.status <> 'settled' THEN
    RAISE EXCEPTION 'BATCH_NOT_SETTLED: status=%', v_batch.status USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO v_txn FROM public.bank_transactions WHERE id = _bank_transaction_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'BANK_TXN_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;
  IF v_txn.organization_id <> v_batch.organization_id THEN
    RAISE EXCEPTION 'ORG_MISMATCH' USING ERRCODE = 'P0001';
  END IF;

  IF NOT public.user_belongs_to_org(v_batch.organization_id) THEN
    RAISE EXCEPTION 'FORBIDDEN' USING ERRCODE = '42501';
  END IF;

  IF v_batch.settled_bank_transaction_id IS NOT NULL
     AND v_batch.settled_bank_transaction_id <> _bank_transaction_id THEN
    RAISE EXCEPTION 'BATCH_ALREADY_MATCHED' USING ERRCODE = 'P0001';
  END IF;

  SELECT id INTO v_match_id
    FROM public.bank_reconciliation_matches
   WHERE legal_order_remittance_batch_id = _batch_id
     AND bank_transaction_id = _bank_transaction_id
     AND status <> 'reversed'
   LIMIT 1;

  IF v_match_id IS NULL THEN
    INSERT INTO public.bank_reconciliation_matches (
      organization_id, business_id, branch_id, bank_transaction_id,
      matched_entity_type, matched_entity_id,
      matched_amount, residual_amount,
      match_type, status, confidence,
      legal_order_remittance_batch_id, created_by
    ) VALUES (
      v_batch.organization_id, v_batch.business_id, NULL, _bank_transaction_id,
      'legal_order_remittance_batch', _batch_id,
      v_batch.planned_total, 0,
      'manual', 'confirmed', 1.00,
      _batch_id, v_actor
    )
    RETURNING id INTO v_match_id;
  END IF;

  UPDATE public.legal_order_remittance_batches
     SET settled_bank_transaction_id = _bank_transaction_id,
         updated_at = now()
   WHERE id = _batch_id
     AND (settled_bank_transaction_id IS NULL OR settled_bank_transaction_id = _bank_transaction_id);

  RETURN v_match_id;
END;
$$;

-- 2. Rewrite legal_order_recipient_statement using correct helper + columns

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
  IF NOT public.user_belongs_to_org(_organization_id) THEN
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
           lor.case_reference    AS order_reference,
           lor.status,
           lor.employee_id,
           lor.total_owed,
           COALESCE(
             (SELECT SUM(gl.amount)
                FROM public.garnishment_ledger gl
               WHERE gl.garnishment_id = lor.id
                 AND gl.payment_date BETWEEN _from AND _to), 0)         AS accrued_period,
           COALESCE(
             (SELECT SUM(rl.amount)
                FROM public.legal_order_remittance_lines rl
               WHERE rl.garnishment_id = lor.id
                 AND rl.payment_date BETWEEN _from AND _to), 0)          AS paid_period,
           COALESCE(
             (SELECT SUM(gl.amount)
                FROM public.garnishment_ledger gl
               WHERE gl.garnishment_id = lor.id), 0)                     AS accrued_to_date,
           COALESCE(
             (SELECT SUM(rl.amount)
                FROM public.legal_order_remittance_lines rl
               WHERE rl.garnishment_id = lor.id), 0)                     AS paid_to_date
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

-- 3. Data repair for the incorrectly-satisfied child-support order --------

UPDATE public.legal_orders_records lor
   SET status = 'active',
       total_accrued = COALESCE((
         SELECT SUM(gl.amount)
           FROM public.garnishment_ledger gl
          WHERE gl.garnishment_id = lor.id
       ), 0),
       updated_at = now()
 WHERE id = '0dfb6e04-b7bd-4e40-9507-ec56fb370f7f'
   AND status = 'satisfied';
