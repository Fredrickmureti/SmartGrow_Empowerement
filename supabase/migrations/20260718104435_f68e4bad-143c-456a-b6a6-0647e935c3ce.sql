
CREATE OR REPLACE FUNCTION public.tg_purchase_order_contract_ceiling()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE
  v_contract RECORD;
  v_po_value numeric(18,4);
  v_item RECORD;
  v_line RECORD;
BEGIN
  IF NOT (lower(coalesce(NEW.status::text,'')) = 'approved'
          AND lower(coalesce(OLD.status::text,'')) <> 'approved') THEN
    RETURN NEW;
  END IF;
  IF NEW.contract_id IS NULL THEN RETURN NEW; END IF;

  SELECT * INTO v_contract FROM public.procurement_contracts
   WHERE id = NEW.contract_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Contract % not found', NEW.contract_id USING ERRCODE='P0002';
  END IF;
  IF v_contract.status <> 'active' THEN
    RAISE EXCEPTION 'Contract % is % — cannot draw a PO from it',
      v_contract.contract_number, v_contract.status USING ERRCODE='22023';
  END IF;
  IF v_contract.end_date IS NOT NULL AND v_contract.end_date < current_date THEN
    RAISE EXCEPTION 'Contract % expired on %', v_contract.contract_number, v_contract.end_date USING ERRCODE='22023';
  END IF;
  IF v_contract.business_id <> NEW.business_id THEN
    RAISE EXCEPTION 'Contract % belongs to a different business', v_contract.contract_number USING ERRCODE='22023';
  END IF;
  IF v_contract.supplier_id NOT IN (SELECT id FROM public.suppliers WHERE contact_id = NEW.vendor_id) THEN
    RAISE EXCEPTION 'Contract supplier does not match PO vendor' USING ERRCODE='22023';
  END IF;

  v_po_value := coalesce(NEW.total, 0);

  IF v_contract.ceiling_value IS NOT NULL
     AND (v_contract.utilized_value + v_po_value) > v_contract.ceiling_value THEN
    INSERT INTO public.business_event_outbox
      (org_id, event_type, source_doc_type, source_doc_id, payload, idempotency_key, actor_user_id, source)
    VALUES (NEW.organization_id, 'procurement.contract.ceiling_breached_attempt',
            'purchase_order', NEW.id,
            jsonb_build_object('contract_id', v_contract.id, 'po_value', v_po_value,
                               'utilized_value', v_contract.utilized_value,
                               'ceiling_value', v_contract.ceiling_value),
            'procurement.contract.ceiling_breached_attempt:' || NEW.id::text,
            auth.uid(), 'procurement')
    ON CONFLICT (idempotency_key) DO NOTHING;
    RAISE EXCEPTION 'Contract % ceiling exceeded (utilized % + PO % > %)',
      v_contract.contract_number, v_contract.utilized_value, v_po_value, v_contract.ceiling_value USING ERRCODE='22023';
  END IF;

  FOR v_item IN
    SELECT * FROM public.purchase_order_items
    WHERE purchase_order_id = NEW.id AND contract_line_id IS NOT NULL
  LOOP
    SELECT * INTO v_line FROM public.procurement_contract_lines
     WHERE id = v_item.contract_line_id FOR UPDATE;
    IF NOT FOUND THEN CONTINUE; END IF;

    IF v_line.ceiling_quantity IS NOT NULL
       AND (v_line.utilized_quantity + coalesce(v_item.quantity,0)) > v_line.ceiling_quantity THEN
      RAISE EXCEPTION 'Contract line "%" quantity ceiling exceeded', v_line.description USING ERRCODE='22023';
    END IF;
    IF v_line.ceiling_value IS NOT NULL
       AND (v_line.utilized_value + coalesce(v_item.line_total,0)) > v_line.ceiling_value THEN
      RAISE EXCEPTION 'Contract line "%" value ceiling exceeded', v_line.description USING ERRCODE='22023';
    END IF;

    UPDATE public.procurement_contract_lines
    SET utilized_quantity = utilized_quantity + coalesce(v_item.quantity,0),
        utilized_value    = utilized_value    + coalesce(v_item.line_total,0),
        updated_at = now()
    WHERE id = v_line.id;

    INSERT INTO public.procurement_contract_releases
      (contract_id, contract_line_id, purchase_order_id, purchase_order_item_id,
       quantity, value, released_by)
    VALUES (v_contract.id, v_line.id, NEW.id, v_item.id,
            coalesce(v_item.quantity,0), coalesce(v_item.line_total,0), auth.uid())
    ON CONFLICT (purchase_order_id, purchase_order_item_id) DO NOTHING;
  END LOOP;

  INSERT INTO public.procurement_contract_releases
    (contract_id, contract_line_id, purchase_order_id, purchase_order_item_id,
     quantity, value, released_by)
  VALUES (v_contract.id, NULL, NEW.id, NULL, 0, v_po_value, auth.uid())
  ON CONFLICT (purchase_order_id, purchase_order_item_id) DO NOTHING;

  UPDATE public.procurement_contracts
     SET utilized_value = utilized_value + v_po_value, updated_at = now()
   WHERE id = v_contract.id;

  RETURN NEW;
END $$;
