CREATE OR REPLACE FUNCTION public.wms_link_return_finance(
  p_return_id uuid,
  p_row_version integer,
  p_finance_doc_type text,
  p_finance_doc_id uuid,
  p_credit_note_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_ord public.wms_return_orders%ROWTYPE;
  v_branch uuid;
  v_new_version integer;
BEGIN
  IF p_finance_doc_type IS NULL OR btrim(p_finance_doc_type) = '' THEN
    RAISE EXCEPTION 'finance_doc_type is required' USING ERRCODE = '22023';
  END IF;
  IF p_finance_doc_type NOT IN ('credit_note','sales_return','purchase_return','vendor_credit','refund') THEN
    RAISE EXCEPTION 'unsupported finance_doc_type %', p_finance_doc_type USING ERRCODE = '22023';
  END IF;
  IF p_finance_doc_id IS NULL THEN
    RAISE EXCEPTION 'finance_doc_id is required' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_ord FROM public.wms_return_orders WHERE id = p_return_id FOR UPDATE;
  IF v_ord.id IS NULL THEN
    RAISE EXCEPTION 'return order % not found', p_return_id USING ERRCODE = '22023';
  END IF;
  IF NOT public.user_can_access_business(auth.uid(), v_ord.business_id) THEN
    RAISE EXCEPTION 'access denied' USING ERRCODE = '42501';
  END IF;
  IF v_ord.row_version <> p_row_version THEN
    RAISE EXCEPTION 'return changed since it was loaded (row_version % <> %)', v_ord.row_version, p_row_version
      USING ERRCODE = '40001';
  END IF;
  IF v_ord.state IN ('cancelled') THEN
    RAISE EXCEPTION 'cannot link finance documents to a cancelled return' USING ERRCODE = '22023';
  END IF;

  v_branch := COALESCE(v_ord.branch_id, (SELECT branch_id FROM public.warehouses WHERE id = v_ord.warehouse_id));
  v_new_version := v_ord.row_version + 1;

  UPDATE public.wms_return_orders
     SET finance_doc_type = p_finance_doc_type,
         finance_doc_id   = p_finance_doc_id,
         credit_note_id   = p_credit_note_id,
         row_version      = v_new_version,
         updated_at       = now()
   WHERE id = v_ord.id;

  PERFORM public._wms_emit_outbox(
    'warehouse.return.finance_linked',
    'wms.return:' || v_ord.id::text || ':finance_linked:' || v_new_version::text,
    v_ord.organization_id, v_ord.business_id,
    jsonb_build_object(
      'aggregate_id', v_ord.id,
      'warehouse_id', v_ord.warehouse_id,
      'branch_id', v_branch,
      'actor_id', auth.uid(),
      'occurred_at', now(),
      'extra', jsonb_build_object(
        'finance_doc_type', p_finance_doc_type,
        'finance_doc_id', p_finance_doc_id,
        'credit_note_id', p_credit_note_id
      )
    )
  );

  RETURN jsonb_build_object(
    'return_id', v_ord.id,
    'row_version', v_new_version,
    'finance_doc_type', p_finance_doc_type,
    'finance_doc_id', p_finance_doc_id,
    'credit_note_id', p_credit_note_id
  );
END
$$;

REVOKE ALL ON FUNCTION public.wms_link_return_finance(uuid, integer, text, uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.wms_link_return_finance(uuid, integer, text, uuid, uuid) TO authenticated;

INSERT INTO public.wms_events_catalog (
  topic, aggregate, transition, producers, consumers, payload_schema, description, idempotency_key_shape
) VALUES (
  'warehouse.return.finance_linked', 'return', 'finance_linked',
  ARRAY['wms_link_return_finance'], ARRAY['finance','sales','audit'],
  '{}'::jsonb,
  'A finance document (credit note / sales or purchase return) was linked to a warehouse return.',
  'wms.return:{id}:finance_linked:{row_version}'
)
ON CONFLICT (topic) DO UPDATE SET
  producers             = EXCLUDED.producers,
  consumers             = EXCLUDED.consumers,
  description           = EXCLUDED.description,
  idempotency_key_shape = EXCLUDED.idempotency_key_shape;