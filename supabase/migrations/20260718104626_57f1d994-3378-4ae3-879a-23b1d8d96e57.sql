
CREATE OR REPLACE FUNCTION public._emit_po_outbox(_business_id uuid, _po_id uuid, _state text, _payload jsonb)
RETURNS void LANGUAGE plpgsql SET search_path=public AS $$
DECLARE v_org uuid;
BEGIN
  SELECT organization_id INTO v_org FROM public.purchase_orders WHERE id=_po_id;
  INSERT INTO public.business_event_outbox
    (org_id, source, event_type, source_doc_type, source_doc_id, payload,
     idempotency_key, status, actor_user_id, created_at)
  VALUES (
    v_org, 'procurement', 'procurement.po.' || _state,
    'purchase_order', _po_id, _payload,
    'procurement.po.' || _state || ':' || _po_id::text || ':' || _state,
    'pending', auth.uid(), now()
  )
  ON CONFLICT (idempotency_key) DO NOTHING;
END $$;
