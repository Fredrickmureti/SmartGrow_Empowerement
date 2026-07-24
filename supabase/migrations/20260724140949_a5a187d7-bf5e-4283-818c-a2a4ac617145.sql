-- ═══════════════════════════════════════════════════════════════════════
-- Phase 7 step 1: Remittance batch closure loop
-- ═══════════════════════════════════════════════════════════════════════

-- 1. Status enum -----------------------------------------------------------
DO $$ BEGIN
  CREATE TYPE public.legal_order_remittance_batch_status AS ENUM
    ('draft','generated','settled','cancelled');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- 2. Batches ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.legal_order_remittance_batches (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id             uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  business_id                 uuid REFERENCES public.businesses(id) ON DELETE SET NULL,
  recipient_id                uuid NOT NULL REFERENCES public.legal_recipients(id) ON DELETE RESTRICT,
  batch_number                text NOT NULL,
  status                      public.legal_order_remittance_batch_status NOT NULL DEFAULT 'draft',
  period_from                 date NOT NULL,
  period_to                   date NOT NULL,
  planned_total               numeric(14,2) NOT NULL DEFAULT 0,
  planned_line_count          integer NOT NULL DEFAULT 0,
  payment_method_id           uuid,
  bank_file_format            text,
  bank_file_checksum          text,
  bank_file_generated_at      timestamptz,
  settled_at                  timestamptz,
  settled_payment_date        date,
  settled_reference           text,
  settled_bank_transaction_id uuid,
  cancelled_at                timestamptz,
  cancelled_reason            text,
  notes                       text,
  created_by                  uuid REFERENCES auth.users(id),
  created_at                  timestamptz NOT NULL DEFAULT now(),
  updated_at                  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT lorb_period_valid CHECK (period_to >= period_from),
  CONSTRAINT lorb_batch_number_unique UNIQUE (organization_id, batch_number)
);

CREATE INDEX IF NOT EXISTS lorb_org_status_idx
  ON public.legal_order_remittance_batches (organization_id, status, period_to DESC);
CREATE INDEX IF NOT EXISTS lorb_recipient_idx
  ON public.legal_order_remittance_batches (recipient_id, period_to DESC);

GRANT SELECT ON public.legal_order_remittance_batches TO authenticated;
GRANT ALL ON public.legal_order_remittance_batches TO service_role;

ALTER TABLE public.legal_order_remittance_batches ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS lorb_read ON public.legal_order_remittance_batches;
CREATE POLICY lorb_read
  ON public.legal_order_remittance_batches FOR SELECT
  TO authenticated
  USING (
    public.has_role(auth.uid(), 'admin')
    OR public.has_role(auth.uid(), 'owner')
    OR public.has_role(auth.uid(), 'accountant')
    OR public.has_role(auth.uid(), 'super_admin')
    OR public.has_role(auth.uid(), 'manager')
  );

COMMENT ON TABLE public.legal_order_remittance_batches IS
  'ADR-0096 Phase 7: recipient-scoped payment batches that group multiple legal-order accruals into a single bank remittance.';

-- 3. Batch lines -----------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.legal_order_remittance_batch_lines (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id           uuid NOT NULL REFERENCES public.legal_order_remittance_batches(id) ON DELETE CASCADE,
  organization_id    uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  garnishment_id     uuid NOT NULL REFERENCES public.legal_orders_records(id) ON DELETE RESTRICT,
  employee_id        uuid,
  planned_amount     numeric(14,2) NOT NULL,
  actual_amount      numeric(14,2),
  remittance_line_id uuid REFERENCES public.legal_order_remittance_lines(id) ON DELETE SET NULL,
  reference_number   text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT lorbl_batch_order_unique UNIQUE (batch_id, garnishment_id)
);

CREATE INDEX IF NOT EXISTS lorbl_batch_idx
  ON public.legal_order_remittance_batch_lines (batch_id);
CREATE INDEX IF NOT EXISTS lorbl_order_idx
  ON public.legal_order_remittance_batch_lines (garnishment_id);

GRANT SELECT ON public.legal_order_remittance_batch_lines TO authenticated;
GRANT ALL ON public.legal_order_remittance_batch_lines TO service_role;

ALTER TABLE public.legal_order_remittance_batch_lines ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS lorbl_read ON public.legal_order_remittance_batch_lines;
CREATE POLICY lorbl_read
  ON public.legal_order_remittance_batch_lines FOR SELECT
  TO authenticated
  USING (
    public.has_role(auth.uid(), 'admin')
    OR public.has_role(auth.uid(), 'owner')
    OR public.has_role(auth.uid(), 'accountant')
    OR public.has_role(auth.uid(), 'super_admin')
    OR public.has_role(auth.uid(), 'manager')
  );

COMMENT ON TABLE public.legal_order_remittance_batch_lines IS
  'ADR-0096 Phase 7: per-order line inside a legal_order_remittance_batches row. remittance_line_id back-links to the settled payment.';

-- 4. touch triggers --------------------------------------------------------
DROP TRIGGER IF EXISTS lorb_touch ON public.legal_order_remittance_batches;
CREATE TRIGGER lorb_touch
  BEFORE UPDATE ON public.legal_order_remittance_batches
  FOR EACH ROW EXECUTE FUNCTION public._set_updated_at();

DROP TRIGGER IF EXISTS lorbl_touch ON public.legal_order_remittance_batch_lines;
CREATE TRIGGER lorbl_touch
  BEFORE UPDATE ON public.legal_order_remittance_batch_lines
  FOR EACH ROW EXECUTE FUNCTION public._set_updated_at();

-- 5. Build RPC -------------------------------------------------------------
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
  IF NOT public.user_has_organization_access(auth.uid(), p_organization_id) THEN
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

  -- Next batch number: LORB-{YYYY}-{seq zero-padded to 6}
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

  -- Per-order pending balance in window = accrued - already-paid remittance lines
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
    -- Nothing to remit: auto-cancel the empty batch.
    UPDATE public.legal_order_remittance_batches
       SET status = 'cancelled',
           cancelled_at = now(),
           cancelled_reason = 'no_pending_accruals'
     WHERE id = v_batch_id;
  END IF;

  RETURN v_batch_id;
END;
$$;

REVOKE ALL ON FUNCTION public.legal_order_build_remittance_batch(uuid,uuid,uuid,date,date,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.legal_order_build_remittance_batch(uuid,uuid,uuid,date,date,text) TO authenticated;

-- 6. Bank-file generator ---------------------------------------------------
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
  IF NOT public.user_has_organization_access(auth.uid(), v_batch.organization_id) THEN
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

REVOKE ALL ON FUNCTION public.legal_order_generate_remittance_bank_file(uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.legal_order_generate_remittance_bank_file(uuid,text) TO authenticated;

-- 7. Settle RPC ------------------------------------------------------------
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
  IF NOT public.user_has_organization_access(auth.uid(), v_batch.organization_id) THEN
    RAISE EXCEPTION 'ORG_ACCESS_DENIED' USING ERRCODE = '42501';
  END IF;
  IF v_batch.status <> 'generated' THEN
    RAISE EXCEPTION 'BATCH_NOT_GENERATED:%', v_batch.status USING ERRCODE = '22023';
  END IF;
  IF v_batch.bank_file_checksum IS NULL THEN
    RAISE EXCEPTION 'BANK_FILE_MISSING' USING ERRCODE = '22023';
  END IF;

  -- One synthetic payment id per batch — used across all remittance lines.
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

  -- Auto-satisfy any orders that are now fully paid.
  PERFORM public.legal_order_auto_satisfy(v_batch.organization_id);

  RETURN jsonb_build_object(
    'batch_id', v_batch.id,
    'settled_lines', v_settled_lines,
    'settled_total', v_settled_total,
    'payment_id', v_pay_id
  );
END;
$$;

REVOKE ALL ON FUNCTION public.legal_order_settle_remittance_batch(uuid,date,text,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.legal_order_settle_remittance_batch(uuid,date,text,uuid) TO authenticated;

-- 8. Cancel RPC ------------------------------------------------------------
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
  IF NOT public.user_has_organization_access(auth.uid(), v_batch.organization_id) THEN
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

REVOKE ALL ON FUNCTION public.legal_order_cancel_remittance_batch(uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.legal_order_cancel_remittance_batch(uuid,text) TO authenticated;

-- 9. Auto-satisfy safety net ----------------------------------------------
CREATE OR REPLACE FUNCTION public.legal_order_auto_satisfy(
  p_organization_id uuid DEFAULT NULL
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_count integer := 0;
  r       RECORD;
BEGIN
  FOR r IN
    SELECT lor.id, lor.organization_id
      FROM public.legal_orders_records lor
     WHERE lor.status IN ('active','suspended')
       AND lor.total_owed IS NOT NULL
       AND lor.total_owed > 0
       AND (p_organization_id IS NULL OR lor.organization_id = p_organization_id)
       AND COALESCE((
             SELECT SUM(rl.amount)
               FROM public.legal_order_remittance_lines rl
              WHERE rl.garnishment_id = lor.id
           ), 0) >= lor.total_owed
  LOOP
    BEGIN
      PERFORM public.apply_system_garnishment_transition(
        r.id,
        'satisfy',
        'auto_satisfied',
        'Auto-satisfied: total remitted >= total owed',
        jsonb_build_object('source','legal_order_auto_satisfy')
      );
      v_count := v_count + 1;
    EXCEPTION WHEN OTHERS THEN
      -- Non-fatal; continue with the next order.
      CONTINUE;
    END;
  END LOOP;
  RETURN v_count;
END;
$$;

REVOKE ALL ON FUNCTION public.legal_order_auto_satisfy(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.legal_order_auto_satisfy(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.legal_order_auto_satisfy(uuid) TO service_role;
