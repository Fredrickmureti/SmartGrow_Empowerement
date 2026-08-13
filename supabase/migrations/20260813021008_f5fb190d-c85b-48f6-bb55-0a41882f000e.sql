CREATE OR REPLACE FUNCTION public.tg_purchase_order_contract_ceiling()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_contract RECORD; v_po_value numeric(18,4); v_item RECORD; v_line RECORD;
  v_qty_base numeric(18,6); v_tol numeric(18,4); v_cycle int;
BEGIN
  IF NOT (lower(coalesce(NEW.status::text,'')) = 'approved'
          AND lower(coalesce(OLD.status::text,'')) <> 'approved') THEN
    RETURN NEW;
  END IF;
  IF NEW.contract_id IS NULL THEN RETURN NEW; END IF;

  SELECT * INTO v_contract FROM public.procurement_contracts WHERE id = NEW.contract_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Contract % not found', NEW.contract_id USING ERRCODE='P0002'; END IF;
  IF v_contract.status <> 'active' THEN
    RAISE EXCEPTION 'Contract % is % — cannot draw a PO from it',
      v_contract.contract_number, v_contract.status USING ERRCODE='22023';
  END IF;
  IF v_contract.start_date > current_date THEN
    RAISE EXCEPTION 'Contract % is not yet effective (starts %)',
      v_contract.contract_number, v_contract.start_date USING ERRCODE='22023';
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
  IF coalesce(NEW.currency, v_contract.currency) <> v_contract.currency THEN
    RAISE EXCEPTION 'PO currency % does not match contract currency %',
      NEW.currency, v_contract.currency USING ERRCODE='22023';
  END IF;

  -- Commitment cycle: a PO that was reversed (cancel / revise) and is approved
  -- again must consume the ceiling a second time. Keying only on the line id
  -- made re-approval a silent no-op and understated utilization.
  SELECT count(*) INTO v_cycle
    FROM public.procurement_contract_releases
   WHERE purchase_order_id = NEW.id AND entry_kind = 'reversal';

  v_po_value := coalesce(NEW.total, 0);

  IF v_contract.ceiling_value IS NOT NULL
     AND (v_contract.committed_value + v_po_value) > v_contract.ceiling_value THEN
    PERFORM public._pc_emit(NEW.organization_id, v_contract.id, 'ceiling_breached_attempt',
      jsonb_build_object('purchase_order_id', NEW.id, 'po_value', v_po_value,
                         'committed_value', v_contract.committed_value,
                         'ceiling_value', v_contract.ceiling_value), NEW.id::text || ':' || v_cycle::text);
    RAISE EXCEPTION 'Contract % ceiling exceeded (committed % + PO % > %)',
      v_contract.contract_number, v_contract.committed_value, v_po_value, v_contract.ceiling_value
      USING ERRCODE='22023';
  END IF;

  FOR v_item IN SELECT * FROM public.purchase_order_items WHERE purchase_order_id = NEW.id LOOP
    IF v_item.contract_line_id IS NULL THEN
      IF v_contract.enforce_item_coverage THEN
        RAISE EXCEPTION 'Item is not covered by contract %', v_contract.contract_number USING ERRCODE='22023';
      END IF;
      CONTINUE;
    END IF;

    SELECT * INTO v_line FROM public.procurement_contract_lines
     WHERE id = v_item.contract_line_id AND contract_id = v_contract.id FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'PO line cites a contract line that does not belong to contract %',
        v_contract.contract_number USING ERRCODE='22023';
    END IF;

    v_tol := greatest(v_line.unit_price * coalesce(v_contract.price_tolerance_percent, 0) / 100.0,
                      coalesce(v_contract.price_tolerance_amount, 0));
    IF v_line.unit_price > 0 AND coalesce(v_item.unit_price, 0) > v_line.unit_price + v_tol THEN
      PERFORM public._pc_emit(NEW.organization_id, v_contract.id, 'price_breached_attempt',
        jsonb_build_object('purchase_order_id', NEW.id, 'contract_line_id', v_line.id,
                           'agreed_price', v_line.unit_price, 'po_price', v_item.unit_price),
        v_item.id::text || ':' || v_cycle::text);
      RAISE EXCEPTION 'PO price % exceeds negotiated price % (tolerance %) on contract line "%"',
        v_item.unit_price, v_line.unit_price, v_tol, v_line.description USING ERRCODE='22023';
    END IF;

    v_qty_base := coalesce(v_item.quantity, 0);
    IF v_item.uom_id IS NOT NULL AND v_line.base_uom_id IS NOT NULL AND v_item.uom_id <> v_line.base_uom_id THEN
      BEGIN
        v_qty_base := public.convert_uom(coalesce(v_item.quantity, 0), v_item.uom_id, v_line.base_uom_id);
      EXCEPTION WHEN OTHERS THEN
        RAISE EXCEPTION 'PO line UoM is not convertible to the contract base unit' USING ERRCODE='22023';
      END;
    END IF;

    IF v_line.ceiling_quantity_base IS NOT NULL
       AND (v_line.committed_quantity_base + v_qty_base) > v_line.ceiling_quantity_base THEN
      RAISE EXCEPTION 'Contract line "%" quantity ceiling exceeded', v_line.description USING ERRCODE='22023';
    END IF;
    IF v_line.ceiling_value IS NOT NULL
       AND (v_line.committed_value + coalesce(v_item.line_total, 0)) > v_line.ceiling_value THEN
      RAISE EXCEPTION 'Contract line "%" value ceiling exceeded', v_line.description USING ERRCODE='22023';
    END IF;

    INSERT INTO public.procurement_contract_releases
      (organization_id, business_id, contract_id, contract_line_id, purchase_order_id,
       purchase_order_item_id, entry_kind, quantity, quantity_base, value, contract_version,
       source_doc_type, source_doc_id, released_by, idempotency_key)
    VALUES (v_contract.organization_id, v_contract.business_id, v_contract.id, v_line.id, NEW.id,
            v_item.id, 'commitment', coalesce(v_item.quantity, 0), v_qty_base,
            coalesce(v_item.line_total, 0), v_contract.current_version,
            'purchase_order', NEW.id, auth.uid(),
            'commitment:' || v_item.id::text || ':' || v_cycle::text)
    ON CONFLICT (idempotency_key) DO NOTHING;

    UPDATE public.purchase_order_items SET contract_unit_price = v_line.unit_price WHERE id = v_item.id;
  END LOOP;

  INSERT INTO public.procurement_contract_releases
    (organization_id, business_id, contract_id, contract_line_id, purchase_order_id,
     entry_kind, quantity, quantity_base, value, contract_version,
     source_doc_type, source_doc_id, released_by, idempotency_key)
  SELECT v_contract.organization_id, v_contract.business_id, v_contract.id, NULL, NEW.id,
         'commitment', 0, 0,
         v_po_value - coalesce((SELECT sum(line_total) FROM public.purchase_order_items
                                 WHERE purchase_order_id = NEW.id AND contract_line_id IS NOT NULL), 0),
         v_contract.current_version, 'purchase_order', NEW.id, auth.uid(),
         'commitment_header:' || NEW.id::text || ':' || v_cycle::text
  ON CONFLICT (idempotency_key) DO NOTHING;

  NEW.contract_version := v_contract.current_version;
  NEW.contract_snapshot := jsonb_build_object(
    'contract_number', v_contract.contract_number,
    'kind', v_contract.kind,
    'supplier_id', v_contract.supplier_id,
    'currency', v_contract.currency,
    'exchange_rate', v_contract.exchange_rate,
    'base_currency', v_contract.base_currency,
    'version', v_contract.current_version,
    'start_date', v_contract.start_date,
    'end_date', v_contract.end_date,
    'commitment_cycle', v_cycle,
    'snapshot_at', now()
  );

  PERFORM public._pc_recompute(v_contract.id);
  PERFORM public._pc_emit(v_contract.organization_id, v_contract.id, 'utilization_changed',
    jsonb_build_object('purchase_order_id', NEW.id, 'stage', 'committed'),
    'commit:' || NEW.id::text || ':' || v_cycle::text);
  RETURN NEW;
END
$fn$;