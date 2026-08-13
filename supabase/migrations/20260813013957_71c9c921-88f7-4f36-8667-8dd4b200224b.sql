-- =====================================================================
-- Procurement Contracts: domain logic (guards, lifecycle, enforcement,
-- utilization ledger, stage posting, events)
-- =====================================================================

-- ---------- shared helpers ----------
CREATE OR REPLACE FUNCTION public._pc_emit(
  _org uuid, _contract_id uuid, _state text, _payload jsonb DEFAULT '{}'::jsonb, _suffix text DEFAULT NULL
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
BEGIN
  INSERT INTO public.business_event_outbox
    (org_id, event_type, source_doc_type, source_doc_id, payload, idempotency_key, actor_user_id, source)
  VALUES (_org, 'procurement.contract.' || _state, 'procurement_contract', _contract_id,
          coalesce(_payload, '{}'::jsonb),
          'procurement.contract.' || _state || ':' || _contract_id::text || coalesce(':' || _suffix, ''),
          auth.uid(), 'procurement')
  ON CONFLICT (org_id, idempotency_key) DO NOTHING;
END $$;

-- currency must be the business base currency or an enabled active currency
CREATE OR REPLACE FUNCTION public._pc_currency_guard()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE v_base text;
BEGIN
  SELECT base_currency INTO v_base FROM public.businesses WHERE id = NEW.business_id;
  NEW.base_currency := coalesce(v_base, NEW.base_currency);
  IF NEW.currency IS DISTINCT FROM v_base
     AND NOT EXISTS (
       SELECT 1 FROM public.business_active_currencies b
        WHERE b.business_id = NEW.business_id AND b.currency_code = NEW.currency AND b.is_enabled
     ) THEN
    RAISE EXCEPTION 'Currency % is not enabled for this business', NEW.currency USING ERRCODE='22023';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_pc_currency_guard ON public.procurement_contracts;
CREATE TRIGGER trg_pc_currency_guard
  BEFORE INSERT OR UPDATE OF currency, business_id ON public.procurement_contracts
  FOR EACH ROW EXECUTE FUNCTION public._pc_currency_guard();

-- lifecycle state machine
CREATE OR REPLACE FUNCTION public._pc_status_guard()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE v_ok boolean;
BEGIN
  IF NEW.status = OLD.status THEN RETURN NEW; END IF;
  v_ok := CASE OLD.status
    WHEN 'draft'            THEN NEW.status IN ('pending_approval','terminated','closed')
    WHEN 'pending_approval' THEN NEW.status IN ('draft','active','terminated')
    WHEN 'active'           THEN NEW.status IN ('suspended','expired','terminated','closed')
    WHEN 'suspended'        THEN NEW.status IN ('active','expired','terminated','closed')
    WHEN 'expired'          THEN NEW.status IN ('active','closed','terminated')
    WHEN 'terminated'       THEN NEW.status IN ('closed')
    ELSE false END;
  IF NOT v_ok THEN
    RAISE EXCEPTION 'Illegal contract transition % -> %', OLD.status, NEW.status USING ERRCODE='22023';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_pc_status_guard ON public.procurement_contracts;
CREATE TRIGGER trg_pc_status_guard
  BEFORE UPDATE OF status ON public.procurement_contracts
  FOR EACH ROW EXECUTE FUNCTION public._pc_status_guard();

-- normalise line ceiling quantity into the product base UoM
CREATE OR REPLACE FUNCTION public._pc_line_normalize()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE v_base uuid;
BEGIN
  IF NEW.product_id IS NOT NULL THEN
    SELECT base_uom_id INTO v_base FROM public.products WHERE id = NEW.product_id;
  END IF;
  NEW.base_uom_id := coalesce(v_base, NEW.uom_id);
  IF NEW.ceiling_quantity IS NULL THEN
    NEW.ceiling_quantity_base := NULL;
  ELSIF NEW.uom_id IS NOT NULL AND NEW.base_uom_id IS NOT NULL AND NEW.uom_id <> NEW.base_uom_id THEN
    BEGIN
      NEW.ceiling_quantity_base := public.convert_uom(NEW.ceiling_quantity, NEW.uom_id, NEW.base_uom_id);
    EXCEPTION WHEN OTHERS THEN
      RAISE EXCEPTION 'Contract line UoM cannot be converted to the product base unit' USING ERRCODE='22023';
    END;
  ELSE
    NEW.ceiling_quantity_base := NEW.ceiling_quantity;
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_pc_line_normalize ON public.procurement_contract_lines;
CREATE TRIGGER trg_pc_line_normalize
  BEFORE INSERT OR UPDATE OF product_id, uom_id, ceiling_quantity ON public.procurement_contract_lines
  FOR EACH ROW EXECUTE FUNCTION public._pc_line_normalize();

-- snapshot the current terms as a new version
CREATE OR REPLACE FUNCTION public._pc_snapshot_version(_contract_id uuid, _effective_from date)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE v_c RECORD; v_next integer; v_lines jsonb;
BEGIN
  SELECT * INTO v_c FROM public.procurement_contracts WHERE id = _contract_id;
  SELECT coalesce(max(version_number), 0) + 1 INTO v_next
    FROM public.procurement_contract_versions WHERE contract_id = _contract_id;
  SELECT coalesce(jsonb_agg(to_jsonb(l) ORDER BY l.sort_order), '[]'::jsonb) INTO v_lines
    FROM public.procurement_contract_lines l WHERE l.contract_id = _contract_id;

  UPDATE public.procurement_contract_versions
     SET effective_to = _effective_from - 1
   WHERE contract_id = _contract_id AND effective_to IS NULL;

  INSERT INTO public.procurement_contract_versions
    (organization_id, business_id, contract_id, version_number, effective_from, header_snapshot, lines_snapshot, created_by)
  VALUES (v_c.organization_id, v_c.business_id, _contract_id, v_next, _effective_from,
          to_jsonb(v_c), v_lines, auth.uid());

  UPDATE public.procurement_contracts SET current_version = v_next, updated_at = now() WHERE id = _contract_id;
  RETURN v_next;
END $$;

-- recompute header/line measures from the append-only ledger
CREATE OR REPLACE FUNCTION public._pc_recompute(_contract_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
BEGIN
  UPDATE public.procurement_contracts c SET
    committed_value = coalesce(l.committed, 0),
    received_value  = coalesce(l.received, 0),
    billed_value    = coalesce(l.billed, 0),
    paid_value      = coalesce(l.paid, 0),
    updated_at = now()
  FROM (
    SELECT
      sum(value) FILTER (WHERE entry_kind IN ('commitment','reversal')) AS committed,
      sum(value) FILTER (WHERE entry_kind = 'receipt')  AS received,
      sum(value) FILTER (WHERE entry_kind = 'billing')  AS billed,
      sum(value) FILTER (WHERE entry_kind = 'payment')  AS paid
    FROM public.procurement_contract_releases WHERE contract_id = _contract_id
  ) l
  WHERE c.id = _contract_id;

  UPDATE public.procurement_contract_lines ln SET
    committed_quantity      = coalesce(agg.c_qty, 0),
    committed_quantity_base = coalesce(agg.c_qty_base, 0),
    committed_value         = coalesce(agg.c_val, 0),
    received_quantity_base  = coalesce(agg.r_qty_base, 0),
    received_value          = coalesce(agg.r_val, 0),
    billed_value            = coalesce(agg.b_val, 0),
    updated_at = now()
  FROM (
    SELECT contract_line_id,
      sum(quantity)      FILTER (WHERE entry_kind IN ('commitment','reversal')) AS c_qty,
      sum(quantity_base) FILTER (WHERE entry_kind IN ('commitment','reversal')) AS c_qty_base,
      sum(value)         FILTER (WHERE entry_kind IN ('commitment','reversal')) AS c_val,
      sum(quantity_base) FILTER (WHERE entry_kind = 'receipt') AS r_qty_base,
      sum(value)         FILTER (WHERE entry_kind = 'receipt') AS r_val,
      sum(value)         FILTER (WHERE entry_kind = 'billing') AS b_val
    FROM public.procurement_contract_releases
    WHERE contract_id = _contract_id AND contract_line_id IS NOT NULL
    GROUP BY contract_line_id
  ) agg
  WHERE ln.id = agg.contract_line_id;
END $$;

-- ---------- lifecycle RPCs ----------
DROP FUNCTION IF EXISTS public.create_procurement_contract(uuid, uuid, text, text, text, text, date, date, numeric, jsonb, text);
DROP FUNCTION IF EXISTS public.terminate_procurement_contract(uuid, text);

CREATE OR REPLACE FUNCTION public.create_procurement_contract(
  p_business_id uuid, p_supplier_id uuid, p_contract_number text, p_title text, p_kind text,
  p_currency text, p_start_date date, p_end_date date, p_ceiling_value numeric,
  p_lines jsonb DEFAULT '[]'::jsonb, p_notes text DEFAULT NULL,
  p_price_tolerance_percent numeric DEFAULT 0, p_price_tolerance_amount numeric DEFAULT 0,
  p_enforce_item_coverage boolean DEFAULT false
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE
  v_uid uuid := auth.uid(); v_org uuid; v_id uuid; v_line jsonb; v_number text; v_seq int;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Not authenticated' USING ERRCODE='42501'; END IF;
  IF NOT public.user_can_access_business(v_uid, p_business_id) THEN
    RAISE EXCEPTION 'Access denied' USING ERRCODE='42501';
  END IF;

  SELECT organization_id INTO v_org FROM public.suppliers
   WHERE id = p_supplier_id AND business_id = p_business_id;
  IF v_org IS NULL THEN RAISE EXCEPTION 'Supplier not found in business' USING ERRCODE='P0002'; END IF;

  IF NOT public.user_has_module_permission(v_uid, v_org, p_business_id, 'purchases', 'write') THEN
    RAISE EXCEPTION 'Purchasing write permission required' USING ERRCODE='42501';
  END IF;

  v_number := nullif(trim(coalesce(p_contract_number, '')), '');
  IF v_number IS NULL THEN
    SELECT count(*) + 1 INTO v_seq FROM public.procurement_contracts WHERE business_id = p_business_id;
    v_number := 'PC-' || to_char(coalesce(p_start_date, current_date), 'YYYY') || '-' || lpad(v_seq::text, 5, '0');
  END IF;

  INSERT INTO public.procurement_contracts
    (organization_id, business_id, supplier_id, contract_number, title, kind, currency,
     start_date, end_date, ceiling_value, notes, created_by,
     price_tolerance_percent, price_tolerance_amount, enforce_item_coverage)
  VALUES (v_org, p_business_id, p_supplier_id, v_number, p_title, coalesce(p_kind, 'blanket'),
          coalesce(p_currency, 'USD'), p_start_date, p_end_date, p_ceiling_value, p_notes, v_uid,
          coalesce(p_price_tolerance_percent, 0), coalesce(p_price_tolerance_amount, 0),
          coalesce(p_enforce_item_coverage, false))
  RETURNING id INTO v_id;

  IF p_lines IS NOT NULL AND jsonb_typeof(p_lines) = 'array' THEN
    FOR v_line IN SELECT * FROM jsonb_array_elements(p_lines) LOOP
      INSERT INTO public.procurement_contract_lines
        (contract_id, product_id, description, uom_id, unit_price, supplier_sku,
         min_quantity, max_quantity, ceiling_quantity, ceiling_value, sort_order)
      VALUES (v_id,
              nullif(v_line->>'product_id','')::uuid,
              coalesce(v_line->>'description',''),
              nullif(v_line->>'uom_id','')::uuid,
              coalesce((v_line->>'unit_price')::numeric, 0),
              nullif(v_line->>'supplier_sku',''),
              (v_line->>'min_quantity')::numeric,
              (v_line->>'max_quantity')::numeric,
              (v_line->>'ceiling_quantity')::numeric,
              (v_line->>'ceiling_value')::numeric,
              coalesce((v_line->>'sort_order')::int, 0));
    END LOOP;
  END IF;

  PERFORM public._pc_snapshot_version(v_id, coalesce(p_start_date, current_date));
  PERFORM public._pc_emit(v_org, v_id, 'created',
    jsonb_build_object('supplier_id', p_supplier_id, 'contract_number', v_number));

  RETURN jsonb_build_object('success', true, 'contract_id', v_id, 'contract_number', v_number);
END $$;

CREATE OR REPLACE FUNCTION public.submit_procurement_contract(p_contract_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE v_c RECORD; v_uid uuid := auth.uid(); v_req uuid;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Not authenticated' USING ERRCODE='42501'; END IF;
  SELECT * INTO v_c FROM public.procurement_contracts WHERE id = p_contract_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('success', false, 'error', 'Contract not found'); END IF;
  IF NOT public.user_can_access_business(v_uid, v_c.business_id) THEN
    RETURN jsonb_build_object('success', false, 'error', 'Access denied'); END IF;
  IF v_c.status <> 'draft' THEN
    RETURN jsonb_build_object('success', false, 'error', 'Only draft contracts can be submitted'); END IF;
  IF NOT EXISTS (SELECT 1 FROM public.procurement_contract_lines WHERE contract_id = p_contract_id) THEN
    RETURN jsonb_build_object('success', false, 'error', 'Add at least one contract line before submitting'); END IF;

  BEGIN
    v_req := (public.approval_route(
      'procurement_contract.activate', 'procurement_contract', p_contract_id,
      v_c.contract_number,
      jsonb_build_object('ceiling_value', v_c.ceiling_value, 'currency', v_c.currency,
                         'supplier_id', v_c.supplier_id),
      jsonb_build_object('business_id', v_c.business_id),
      'procurement_contract.activate:' || p_contract_id::text,
      v_c.business_id
    )->>'approval_request_id')::uuid;
  EXCEPTION WHEN OTHERS THEN v_req := NULL;
  END;

  UPDATE public.procurement_contracts
     SET status = 'pending_approval', submitted_by = v_uid, submitted_at = now(),
         approval_request_id = coalesce(v_req, approval_request_id), updated_at = now()
   WHERE id = p_contract_id;

  PERFORM public._pc_emit(v_c.organization_id, p_contract_id, 'submitted',
    jsonb_build_object('approval_request_id', v_req));
  RETURN jsonb_build_object('success', true, 'approval_request_id', v_req);
END $$;

CREATE OR REPLACE FUNCTION public.activate_procurement_contract(p_contract_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE v_c RECORD; v_uid uuid := auth.uid(); v_rate numeric; v_base text;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Not authenticated' USING ERRCODE='42501'; END IF;
  SELECT * INTO v_c FROM public.procurement_contracts WHERE id = p_contract_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('success', false, 'error', 'Contract not found'); END IF;
  IF NOT public.user_can_access_business(v_uid, v_c.business_id) THEN
    RETURN jsonb_build_object('success', false, 'error', 'Access denied'); END IF;
  IF NOT public.user_has_module_permission(v_uid, v_c.organization_id, v_c.business_id, 'purchases', 'write') THEN
    RETURN jsonb_build_object('success', false, 'error', 'Purchasing approval permission required'); END IF;
  IF v_c.status NOT IN ('pending_approval','suspended','expired') THEN
    RETURN jsonb_build_object('success', false, 'error', 'Contract must be submitted for approval first'); END IF;
  IF v_c.status = 'pending_approval' AND v_c.created_by = v_uid THEN
    RETURN jsonb_build_object('success', false, 'error', 'Segregation of duties: approver cannot be the creator'); END IF;
  IF v_c.end_date IS NOT NULL AND v_c.end_date < current_date THEN
    RETURN jsonb_build_object('success', false, 'error', 'Extend the end date before activating'); END IF;

  SELECT base_currency INTO v_base FROM public.businesses WHERE id = v_c.business_id;
  IF v_c.currency = v_base THEN
    v_rate := 1;
  ELSE
    SELECT rate INTO v_rate FROM public.exchange_rates
     WHERE organization_id = v_c.organization_id
       AND from_currency = v_c.currency AND to_currency = v_base
       AND effective_date <= current_date
     ORDER BY effective_date DESC LIMIT 1;
  END IF;

  UPDATE public.procurement_contracts
     SET status = 'active', approved_by = v_uid, approved_at = now(),
         base_currency = v_base, exchange_rate = v_rate, exchange_rate_date = current_date,
         updated_at = now()
   WHERE id = p_contract_id;

  PERFORM public._pc_emit(v_c.organization_id, p_contract_id, 'activated',
    jsonb_build_object('supplier_id', v_c.supplier_id, 'exchange_rate', v_rate), v_c.status::text);
  RETURN jsonb_build_object('success', true, 'exchange_rate', v_rate);
END $$;

CREATE OR REPLACE FUNCTION public.amend_procurement_contract(
  p_contract_id uuid, p_kind text, p_effective_on date, p_changes jsonb, p_reason text DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE v_c RECORD; v_uid uuid := auth.uid(); v_from int; v_to int; v_no int; v_line jsonb;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Not authenticated' USING ERRCODE='42501'; END IF;
  SELECT * INTO v_c FROM public.procurement_contracts WHERE id = p_contract_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('success', false, 'error', 'Contract not found'); END IF;
  IF NOT public.user_can_access_business(v_uid, v_c.business_id) THEN
    RETURN jsonb_build_object('success', false, 'error', 'Access denied'); END IF;
  IF v_c.status IN ('terminated','closed') THEN
    RETURN jsonb_build_object('success', false, 'error', 'Closed contracts cannot be amended'); END IF;

  v_from := v_c.current_version;

  UPDATE public.procurement_contracts SET
    title         = coalesce(p_changes->>'title', title),
    end_date      = coalesce(nullif(p_changes->>'end_date','')::date, end_date),
    ceiling_value = coalesce(nullif(p_changes->>'ceiling_value','')::numeric, ceiling_value),
    notes         = coalesce(p_changes->>'notes', notes),
    price_tolerance_percent = coalesce(nullif(p_changes->>'price_tolerance_percent','')::numeric, price_tolerance_percent),
    price_tolerance_amount  = coalesce(nullif(p_changes->>'price_tolerance_amount','')::numeric, price_tolerance_amount),
    updated_at = now()
  WHERE id = p_contract_id;

  IF jsonb_typeof(p_changes->'lines') = 'array' THEN
    FOR v_line IN SELECT * FROM jsonb_array_elements(p_changes->'lines') LOOP
      UPDATE public.procurement_contract_lines SET
        unit_price       = coalesce(nullif(v_line->>'unit_price','')::numeric, unit_price),
        ceiling_quantity = coalesce(nullif(v_line->>'ceiling_quantity','')::numeric, ceiling_quantity),
        ceiling_value    = coalesce(nullif(v_line->>'ceiling_value','')::numeric, ceiling_value),
        effective_from   = coalesce(nullif(v_line->>'effective_from','')::date, effective_from),
        effective_to     = coalesce(nullif(v_line->>'effective_to','')::date, effective_to)
      WHERE id = (v_line->>'id')::uuid AND contract_id = p_contract_id;
    END LOOP;
  END IF;

  IF v_c.ceiling_value IS NOT NULL
     AND (p_changes ? 'ceiling_value')
     AND (p_changes->>'ceiling_value')::numeric < v_c.committed_value THEN
    RAISE EXCEPTION 'New ceiling % is below the % already committed',
      p_changes->>'ceiling_value', v_c.committed_value USING ERRCODE='22023';
  END IF;

  v_to := public._pc_snapshot_version(p_contract_id, coalesce(p_effective_on, current_date));
  SELECT coalesce(max(amendment_number), 0) + 1 INTO v_no
    FROM public.procurement_contract_amendments WHERE contract_id = p_contract_id;

  INSERT INTO public.procurement_contract_amendments
    (organization_id, business_id, contract_id, from_version, to_version, amendment_number,
     kind, effective_on, reason, changes, created_by)
  VALUES (v_c.organization_id, v_c.business_id, p_contract_id, v_from, v_to, v_no,
          coalesce(p_kind, 'other'), coalesce(p_effective_on, current_date), p_reason,
          coalesce(p_changes, '{}'::jsonb), v_uid);

  PERFORM public._pc_emit(v_c.organization_id, p_contract_id, 'amended',
    jsonb_build_object('amendment_number', v_no, 'to_version', v_to), v_no::text);
  RETURN jsonb_build_object('success', true, 'version', v_to, 'amendment_number', v_no);
END $$;

DROP FUNCTION IF EXISTS public.amend_procurement_contract(uuid, text, date, numeric, text);

CREATE OR REPLACE FUNCTION public.set_procurement_contract_state(
  p_contract_id uuid, p_action text, p_reason text DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE v_c RECORD; v_uid uuid := auth.uid(); v_new public.procurement_contract_status;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Not authenticated' USING ERRCODE='42501'; END IF;
  SELECT * INTO v_c FROM public.procurement_contracts WHERE id = p_contract_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('success', false, 'error', 'Contract not found'); END IF;
  IF NOT public.user_can_access_business(v_uid, v_c.business_id) THEN
    RETURN jsonb_build_object('success', false, 'error', 'Access denied'); END IF;

  v_new := CASE p_action
             WHEN 'suspend' THEN 'suspended'
             WHEN 'resume' THEN 'active'
             WHEN 'terminate' THEN 'terminated'
             WHEN 'close' THEN 'closed'
             WHEN 'withdraw' THEN 'draft'
             ELSE NULL END::public.procurement_contract_status;
  IF v_new IS NULL THEN RETURN jsonb_build_object('success', false, 'error', 'Unknown action'); END IF;

  UPDATE public.procurement_contracts SET
    status = v_new,
    suspended_by = CASE WHEN v_new = 'suspended' THEN v_uid ELSE suspended_by END,
    suspended_at = CASE WHEN v_new = 'suspended' THEN now() ELSE suspended_at END,
    suspension_reason = CASE WHEN v_new = 'suspended' THEN p_reason ELSE suspension_reason END,
    terminated_by = CASE WHEN v_new = 'terminated' THEN v_uid ELSE terminated_by END,
    terminated_at = CASE WHEN v_new = 'terminated' THEN now() ELSE terminated_at END,
    terminated_reason = CASE WHEN v_new = 'terminated' THEN p_reason ELSE terminated_reason END,
    closed_at = CASE WHEN v_new = 'closed' THEN now() ELSE closed_at END,
    updated_at = now()
  WHERE id = p_contract_id;

  PERFORM public._pc_emit(v_c.organization_id, p_contract_id,
    CASE p_action WHEN 'suspend' THEN 'suspended' WHEN 'resume' THEN 'resumed'
                  WHEN 'terminate' THEN 'terminated' WHEN 'close' THEN 'closed'
                  ELSE 'withdrawn' END,
    jsonb_build_object('reason', p_reason), to_char(now(), 'YYYYMMDDHH24MISS'));
  RETURN jsonb_build_object('success', true, 'status', v_new);
END $$;

CREATE OR REPLACE FUNCTION public.terminate_procurement_contract(p_contract_id uuid, p_reason text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
BEGIN
  RETURN public.set_procurement_contract_state(p_contract_id, 'terminate', p_reason);
END $$;

CREATE OR REPLACE FUNCTION public.renew_procurement_contract(
  p_contract_id uuid, p_new_end_date date, p_new_ceiling_value numeric DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE v_res jsonb;
BEGIN
  v_res := public.amend_procurement_contract(
    p_contract_id, 'renewal', current_date,
    jsonb_strip_nulls(jsonb_build_object('end_date', p_new_end_date, 'ceiling_value', p_new_ceiling_value)),
    'Contract renewal');
  RETURN v_res;
END $$;

-- ---------- PO enforcement + commitment ----------
CREATE OR REPLACE FUNCTION public.tg_purchase_order_contract_ceiling()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE
  v_contract RECORD; v_po_value numeric(18,4); v_item RECORD; v_line RECORD;
  v_qty_base numeric(18,6); v_tol numeric(18,4);
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

  v_po_value := coalesce(NEW.total, 0);

  IF v_contract.ceiling_value IS NOT NULL
     AND (v_contract.committed_value + v_po_value) > v_contract.ceiling_value THEN
    PERFORM public._pc_emit(NEW.organization_id, v_contract.id, 'ceiling_breached_attempt',
      jsonb_build_object('purchase_order_id', NEW.id, 'po_value', v_po_value,
                         'committed_value', v_contract.committed_value,
                         'ceiling_value', v_contract.ceiling_value), NEW.id::text);
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

    -- negotiated price enforcement within tolerance
    v_tol := greatest(v_line.unit_price * coalesce(v_contract.price_tolerance_percent, 0) / 100.0,
                      coalesce(v_contract.price_tolerance_amount, 0));
    IF v_line.unit_price > 0 AND coalesce(v_item.unit_price, 0) > v_line.unit_price + v_tol THEN
      PERFORM public._pc_emit(NEW.organization_id, v_contract.id, 'price_breached_attempt',
        jsonb_build_object('purchase_order_id', NEW.id, 'contract_line_id', v_line.id,
                           'agreed_price', v_line.unit_price, 'po_price', v_item.unit_price), v_item.id::text);
      RAISE EXCEPTION 'PO price % exceeds negotiated price % (tolerance %) on contract line "%"',
        v_item.unit_price, v_line.unit_price, v_tol, v_line.description USING ERRCODE='22023';
    END IF;

    -- quantity normalised to base UoM: one canonical quantity model
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
            'commitment:' || v_item.id::text)
    ON CONFLICT (idempotency_key) DO NOTHING;

    UPDATE public.purchase_order_items SET contract_unit_price = v_line.unit_price WHERE id = v_item.id;
  END LOOP;

  -- header-level commitment for the residual (non line-linked) PO value
  INSERT INTO public.procurement_contract_releases
    (organization_id, business_id, contract_id, contract_line_id, purchase_order_id,
     entry_kind, quantity, quantity_base, value, contract_version,
     source_doc_type, source_doc_id, released_by, idempotency_key)
  SELECT v_contract.organization_id, v_contract.business_id, v_contract.id, NULL, NEW.id,
         'commitment', 0, 0,
         v_po_value - coalesce((SELECT sum(line_total) FROM public.purchase_order_items
                                 WHERE purchase_order_id = NEW.id AND contract_line_id IS NOT NULL), 0),
         v_contract.current_version, 'purchase_order', NEW.id, auth.uid(),
         'commitment_header:' || NEW.id::text
  ON CONFLICT (idempotency_key) DO NOTHING;

  -- historical truth: snapshot the terms in force at issuance
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
    'snapshot_at', now()
  );

  PERFORM public._pc_recompute(v_contract.id);
  PERFORM public._pc_emit(v_contract.organization_id, v_contract.id, 'utilization_changed',
    jsonb_build_object('purchase_order_id', NEW.id, 'stage', 'committed'), 'commit:' || NEW.id::text);
  RETURN NEW;
END $$;

-- release capacity when a PO leaves the approved state
CREATE OR REPLACE FUNCTION public.tg_purchase_order_contract_reversal()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE v_c RECORD;
BEGIN
  IF NEW.contract_id IS NULL THEN RETURN NEW; END IF;
  IF NOT (lower(coalesce(NEW.status::text,'')) IN ('cancelled','rejected','revised','draft')
          AND lower(coalesce(OLD.status::text,'')) = 'approved') THEN
    RETURN NEW;
  END IF;

  SELECT * INTO v_c FROM public.procurement_contracts WHERE id = NEW.contract_id FOR UPDATE;
  IF NOT FOUND THEN RETURN NEW; END IF;

  INSERT INTO public.procurement_contract_releases
    (organization_id, business_id, contract_id, contract_line_id, purchase_order_id,
     purchase_order_item_id, entry_kind, quantity, quantity_base, value, contract_version,
     source_doc_type, source_doc_id, released_by, idempotency_key)
  SELECT r.organization_id, r.business_id, r.contract_id, r.contract_line_id, r.purchase_order_id,
         r.purchase_order_item_id, 'reversal', -r.quantity, -r.quantity_base, -r.value, r.contract_version,
         'purchase_order', NEW.id, auth.uid(),
         'reversal:' || r.id::text
    FROM public.procurement_contract_releases r
   WHERE r.purchase_order_id = NEW.id AND r.entry_kind = 'commitment'
  ON CONFLICT (idempotency_key) DO NOTHING;

  PERFORM public._pc_recompute(v_c.id);
  PERFORM public._pc_emit(v_c.organization_id, v_c.id, 'utilization_changed',
    jsonb_build_object('purchase_order_id', NEW.id, 'stage', 'reversed'), 'reverse:' || NEW.id::text);
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_purchase_order_contract_reversal ON public.purchase_orders;
CREATE TRIGGER trg_purchase_order_contract_reversal
  AFTER UPDATE OF status ON public.purchase_orders
  FOR EACH ROW EXECUTE FUNCTION public.tg_purchase_order_contract_reversal();

-- ---------- stage posting: receipt, billing, payment ----------
CREATE OR REPLACE FUNCTION public.tg_goods_receipt_contract_stage()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE v_rel RECORD; v_qty numeric;
BEGIN
  IF NEW.purchase_order_item_id IS NULL THEN RETURN NEW; END IF;
  SELECT * INTO v_rel FROM public.procurement_contract_releases
   WHERE purchase_order_item_id = NEW.purchase_order_item_id AND entry_kind = 'commitment' LIMIT 1;
  IF NOT FOUND THEN RETURN NEW; END IF;

  v_qty := coalesce(NEW.quantity_received, 0);

  INSERT INTO public.procurement_contract_releases
    (organization_id, business_id, contract_id, contract_line_id, purchase_order_id,
     purchase_order_item_id, entry_kind, quantity, quantity_base, value, contract_version,
     source_doc_type, source_doc_id, released_by, idempotency_key)
  VALUES (v_rel.organization_id, v_rel.business_id, v_rel.contract_id, v_rel.contract_line_id,
          v_rel.purchase_order_id, NEW.purchase_order_item_id, 'receipt', v_qty, v_qty,
          CASE WHEN coalesce(v_rel.quantity, 0) > 0 THEN v_rel.value * v_qty / v_rel.quantity ELSE 0 END,
          v_rel.contract_version, 'goods_receipt_item', NEW.id, auth.uid(),
          'receipt:' || NEW.id::text)
  ON CONFLICT (idempotency_key) DO NOTHING;

  PERFORM public._pc_recompute(v_rel.contract_id);
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_goods_receipt_contract_stage ON public.goods_receipt_items;
CREATE TRIGGER trg_goods_receipt_contract_stage
  AFTER INSERT ON public.goods_receipt_items
  FOR EACH ROW EXECUTE FUNCTION public.tg_goods_receipt_contract_stage();

CREATE OR REPLACE FUNCTION public.tg_bill_item_contract_stage()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE v_rel RECORD;
BEGIN
  IF NEW.purchase_order_item_id IS NULL THEN RETURN NEW; END IF;
  SELECT * INTO v_rel FROM public.procurement_contract_releases
   WHERE purchase_order_item_id = NEW.purchase_order_item_id AND entry_kind = 'commitment' LIMIT 1;
  IF NOT FOUND THEN RETURN NEW; END IF;

  INSERT INTO public.procurement_contract_releases
    (organization_id, business_id, contract_id, contract_line_id, purchase_order_id,
     purchase_order_item_id, entry_kind, quantity, quantity_base, value, contract_version,
     source_doc_type, source_doc_id, released_by, idempotency_key)
  VALUES (v_rel.organization_id, v_rel.business_id, v_rel.contract_id, v_rel.contract_line_id,
          v_rel.purchase_order_id, NEW.purchase_order_item_id, 'billing',
          coalesce(NEW.quantity, 0), coalesce(NEW.quantity, 0), coalesce(NEW.line_total, 0),
          v_rel.contract_version, 'bill_item', NEW.id, auth.uid(),
          'billing:' || NEW.id::text)
  ON CONFLICT (idempotency_key) DO NOTHING;

  PERFORM public._pc_recompute(v_rel.contract_id);
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_bill_item_contract_stage ON public.bill_items;
CREATE TRIGGER trg_bill_item_contract_stage
  AFTER INSERT ON public.bill_items
  FOR EACH ROW EXECUTE FUNCTION public.tg_bill_item_contract_stage();

CREATE OR REPLACE FUNCTION public.tg_bill_payment_contract_stage()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE v_contract_id uuid; v_org uuid; v_biz uuid; v_delta numeric;
BEGIN
  v_delta := coalesce(NEW.amount_paid, 0) - coalesce(OLD.amount_paid, 0);
  IF v_delta = 0 THEN RETURN NEW; END IF;

  SELECT po.contract_id, po.organization_id, po.business_id
    INTO v_contract_id, v_org, v_biz
    FROM public.purchase_orders po
   WHERE po.id = coalesce(NEW.purchase_order_id, NEW.source_purchase_order_id);
  IF v_contract_id IS NULL THEN RETURN NEW; END IF;

  INSERT INTO public.procurement_contract_releases
    (organization_id, business_id, contract_id, purchase_order_id, entry_kind,
     quantity, quantity_base, value, source_doc_type, source_doc_id, released_by, idempotency_key)
  VALUES (v_org, v_biz, v_contract_id, coalesce(NEW.purchase_order_id, NEW.source_purchase_order_id),
          'payment', 0, 0, v_delta, 'bill', NEW.id, auth.uid(),
          'payment:' || NEW.id::text || ':' || to_char(now(), 'YYYYMMDDHH24MISSUS'))
  ON CONFLICT (idempotency_key) DO NOTHING;

  PERFORM public._pc_recompute(v_contract_id);
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_bill_payment_contract_stage ON public.bills;
CREATE TRIGGER trg_bill_payment_contract_stage
  AFTER UPDATE OF amount_paid ON public.bills
  FOR EACH ROW EXECUTE FUNCTION public.tg_bill_payment_contract_stage();

-- ---------- expiry sweep uses the enum + guard ----------
CREATE OR REPLACE FUNCTION public.procurement_contracts_sweep_expiries()
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE v_row RECORD; v_count int := 0;
BEGIN
  FOR v_row IN
    SELECT * FROM public.procurement_contracts
     WHERE status IN ('active','suspended') AND end_date IS NOT NULL AND end_date < current_date
     FOR UPDATE
  LOOP
    UPDATE public.procurement_contracts SET status = 'expired', updated_at = now() WHERE id = v_row.id;
    PERFORM public._pc_emit(v_row.organization_id, v_row.id, 'expired',
      jsonb_build_object('end_date', v_row.end_date));
    v_count := v_count + 1;
  END LOOP;
  RETURN v_count;
END $$;

-- ---------- reporting view ----------
CREATE OR REPLACE VIEW public.v_procurement_contract_utilization AS
SELECT
  c.id AS contract_id,
  c.business_id,
  c.organization_id,
  c.contract_number,
  c.title,
  c.supplier_id,
  c.status,
  c.currency,
  c.base_currency,
  c.exchange_rate,
  c.start_date,
  c.end_date,
  c.ceiling_value,
  c.committed_value,
  c.received_value,
  c.billed_value,
  c.paid_value,
  CASE WHEN c.ceiling_value IS NULL THEN NULL
       ELSE c.ceiling_value - c.committed_value END AS remaining_value,
  CASE WHEN coalesce(c.ceiling_value, 0) = 0 THEN NULL
       ELSE round(100 * c.committed_value / c.ceiling_value, 2) END AS utilization_percent,
  CASE WHEN c.end_date IS NULL THEN NULL
       ELSE c.end_date - current_date END AS days_to_expiry
FROM public.procurement_contracts c;

GRANT SELECT ON public.v_procurement_contract_utilization TO authenticated;