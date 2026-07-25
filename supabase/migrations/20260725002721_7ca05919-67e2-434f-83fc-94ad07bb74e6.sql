
CREATE OR REPLACE FUNCTION public.legal_order_generate_remittance_bank_file(
  p_batch_id uuid,
  p_format   text DEFAULT 'csv'
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
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

  v_checksum := encode(extensions.digest(v_body::bytea, 'sha256'), 'hex');

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
