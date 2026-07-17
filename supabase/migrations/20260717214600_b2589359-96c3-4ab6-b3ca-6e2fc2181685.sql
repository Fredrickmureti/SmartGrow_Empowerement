
-- Phase 7 — QC inspection lifecycle

CREATE TABLE public.wms_qc_hold_reasons (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  business_id uuid NOT NULL,
  code text NOT NULL,
  label text NOT NULL,
  severity text NOT NULL DEFAULT 'minor' CHECK (severity IN ('minor','major','critical')),
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (business_id, code)
);

GRANT SELECT ON public.wms_qc_hold_reasons TO authenticated;
GRANT ALL ON public.wms_qc_hold_reasons TO service_role;
ALTER TABLE public.wms_qc_hold_reasons ENABLE ROW LEVEL SECURITY;

CREATE POLICY "wms_qc_hold_reasons_select" ON public.wms_qc_hold_reasons
  FOR SELECT TO authenticated
  USING (business_id IN (SELECT business_id FROM public.user_business_access WHERE user_id = auth.uid()));

CREATE TABLE public.wms_qc_inspections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  business_id uuid NOT NULL,
  branch_id uuid,
  warehouse_id uuid NOT NULL REFERENCES public.warehouses(id) ON DELETE RESTRICT,
  source_doc_type text NOT NULL CHECK (source_doc_type IN ('goods_receipt','sales_return','ad_hoc')),
  source_doc_id uuid,
  product_id uuid REFERENCES public.products(id) ON DELETE RESTRICT,
  lot_number text,
  serial_number text,
  quantity numeric NOT NULL DEFAULT 0,
  sample_size integer NOT NULL DEFAULT 0,
  sample_strategy text NOT NULL DEFAULT 'full' CHECK (sample_strategy IN ('aql','full','skip')),
  state text NOT NULL DEFAULT 'open' CHECK (state IN ('open','in_review','accepted','partially_accepted','rejected','cancelled')),
  accepted_qty numeric NOT NULL DEFAULT 0,
  rejected_qty numeric NOT NULL DEFAULT 0,
  disposition text CHECK (disposition IN ('return_to_vendor','scrap','rework','use_as_is')),
  inspector_id uuid,
  inspected_at timestamptz,
  notes text,
  cancelled_reason text,
  is_sample_data boolean NOT NULL DEFAULT false,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_wms_qc_inspections_business_state ON public.wms_qc_inspections(business_id, state);
CREATE INDEX idx_wms_qc_inspections_source ON public.wms_qc_inspections(source_doc_type, source_doc_id);

GRANT SELECT ON public.wms_qc_inspections TO authenticated;
GRANT ALL ON public.wms_qc_inspections TO service_role;
ALTER TABLE public.wms_qc_inspections ENABLE ROW LEVEL SECURITY;

CREATE POLICY "wms_qc_inspections_select" ON public.wms_qc_inspections
  FOR SELECT TO authenticated
  USING (business_id IN (SELECT business_id FROM public.user_business_access WHERE user_id = auth.uid()));

CREATE TABLE public.wms_qc_inspection_checks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  inspection_id uuid NOT NULL REFERENCES public.wms_qc_inspections(id) ON DELETE CASCADE,
  check_code text NOT NULL,
  check_label text NOT NULL,
  expected text,
  actual text,
  pass boolean,
  severity text CHECK (severity IN ('minor','major','critical')),
  photo_url text,
  recorded_by uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_wms_qc_inspection_checks_inspection ON public.wms_qc_inspection_checks(inspection_id);

GRANT SELECT ON public.wms_qc_inspection_checks TO authenticated;
GRANT ALL ON public.wms_qc_inspection_checks TO service_role;
ALTER TABLE public.wms_qc_inspection_checks ENABLE ROW LEVEL SECURITY;

CREATE POLICY "wms_qc_inspection_checks_select" ON public.wms_qc_inspection_checks
  FOR SELECT TO authenticated
  USING (inspection_id IN (SELECT id FROM public.wms_qc_inspections WHERE business_id IN (SELECT business_id FROM public.user_business_access WHERE user_id = auth.uid())));

-- FK links from source docs
ALTER TABLE public.goods_receipt_items ADD COLUMN IF NOT EXISTS qc_inspection_id uuid REFERENCES public.wms_qc_inspections(id) ON DELETE SET NULL;
ALTER TABLE public.sales_return_items ADD COLUMN IF NOT EXISTS qc_inspection_id uuid REFERENCES public.wms_qc_inspections(id) ON DELETE SET NULL;

-- Warehouse flag
ALTER TABLE public.warehouses ADD COLUMN IF NOT EXISTS require_qc_on_receipt boolean NOT NULL DEFAULT false;

-- updated_at trigger
CREATE OR REPLACE FUNCTION public.tg_wms_qc_touch_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END; $$;

CREATE TRIGGER tg_wms_qc_inspections_updated_at BEFORE UPDATE ON public.wms_qc_inspections
  FOR EACH ROW EXECUTE FUNCTION public.tg_wms_qc_touch_updated_at();
CREATE TRIGGER tg_wms_qc_hold_reasons_updated_at BEFORE UPDATE ON public.wms_qc_hold_reasons
  FOR EACH ROW EXECUTE FUNCTION public.tg_wms_qc_touch_updated_at();

-- Event emitter helper
CREATE OR REPLACE FUNCTION public.emit_qc_event(
  p_type text, p_insp public.wms_qc_inspections
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  BEGIN
    INSERT INTO public.business_event_outbox (
      event_type, organization_id, business_id, branch_id,
      source_doc_type, source_doc_id, payload, idempotency_key, status
    ) VALUES (
      p_type, p_insp.organization_id, p_insp.business_id, p_insp.branch_id,
      'qc_inspection', p_insp.id,
      jsonb_build_object(
        'inspection_id', p_insp.id,
        'warehouse_id', p_insp.warehouse_id,
        'product_id', p_insp.product_id,
        'state', p_insp.state,
        'accepted_qty', p_insp.accepted_qty,
        'rejected_qty', p_insp.rejected_qty,
        'disposition', p_insp.disposition
      ),
      'wms.qc.' || p_insp.id || ':' || p_insp.state,
      'pending'
    );
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'qc event emission failed: %', SQLERRM;
  END;
END; $$;

-- RPC: open_qc_inspection
CREATE OR REPLACE FUNCTION public.open_qc_inspection(
  p_warehouse_id uuid,
  p_source_doc_type text,
  p_source_doc_id uuid,
  p_product_id uuid,
  p_quantity numeric,
  p_lot_number text DEFAULT NULL,
  p_serial_number text DEFAULT NULL,
  p_sample_size integer DEFAULT 0,
  p_sample_strategy text DEFAULT 'full'
) RETURNS public.wms_qc_inspections LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_wh public.warehouses;
  v_row public.wms_qc_inspections;
BEGIN
  SELECT * INTO v_wh FROM public.warehouses WHERE id = p_warehouse_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'warehouse not found'; END IF;
  IF v_wh.business_id NOT IN (SELECT business_id FROM public.user_business_access WHERE user_id = auth.uid()) THEN
    RAISE EXCEPTION 'access denied to warehouse';
  END IF;

  INSERT INTO public.wms_qc_inspections (
    organization_id, business_id, warehouse_id,
    source_doc_type, source_doc_id, product_id, quantity,
    lot_number, serial_number, sample_size, sample_strategy,
    state, inspector_id, created_by
  ) VALUES (
    v_wh.organization_id, v_wh.business_id, p_warehouse_id,
    p_source_doc_type, p_source_doc_id, p_product_id, p_quantity,
    p_lot_number, p_serial_number, p_sample_size, p_sample_strategy,
    'open', auth.uid(), auth.uid()
  ) RETURNING * INTO v_row;

  PERFORM public.emit_qc_event('warehouse.qc.opened', v_row);
  RETURN v_row;
END; $$;

GRANT EXECUTE ON FUNCTION public.open_qc_inspection(uuid,text,uuid,uuid,numeric,text,text,integer,text) TO authenticated;

-- RPC: record_qc_check
CREATE OR REPLACE FUNCTION public.record_qc_check(
  p_inspection_id uuid,
  p_check_code text,
  p_check_label text,
  p_expected text,
  p_actual text,
  p_pass boolean,
  p_severity text DEFAULT NULL,
  p_photo_url text DEFAULT NULL
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_insp public.wms_qc_inspections;
  v_id uuid;
BEGIN
  SELECT * INTO v_insp FROM public.wms_qc_inspections WHERE id = p_inspection_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'inspection not found'; END IF;
  IF v_insp.business_id NOT IN (SELECT business_id FROM public.user_business_access WHERE user_id = auth.uid()) THEN
    RAISE EXCEPTION 'access denied';
  END IF;
  IF v_insp.state NOT IN ('open','in_review') THEN
    RAISE EXCEPTION 'cannot record check on inspection in state %', v_insp.state;
  END IF;

  INSERT INTO public.wms_qc_inspection_checks (
    inspection_id, check_code, check_label, expected, actual, pass, severity, photo_url, recorded_by
  ) VALUES (p_inspection_id, p_check_code, p_check_label, p_expected, p_actual, p_pass, p_severity, p_photo_url, auth.uid())
  RETURNING id INTO v_id;

  IF v_insp.state = 'open' THEN
    UPDATE public.wms_qc_inspections SET state = 'in_review' WHERE id = p_inspection_id;
  END IF;

  RETURN v_id;
END; $$;

GRANT EXECUTE ON FUNCTION public.record_qc_check(uuid,text,text,text,text,boolean,text,text) TO authenticated;

-- RPC: accept_qc_inspection
CREATE OR REPLACE FUNCTION public.accept_qc_inspection(
  p_inspection_id uuid,
  p_accepted_qty numeric,
  p_notes text DEFAULT NULL
) RETURNS public.wms_qc_inspections LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_insp public.wms_qc_inspections;
  v_state text;
BEGIN
  SELECT * INTO v_insp FROM public.wms_qc_inspections WHERE id = p_inspection_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'inspection not found'; END IF;
  IF v_insp.business_id NOT IN (SELECT business_id FROM public.user_business_access WHERE user_id = auth.uid()) THEN
    RAISE EXCEPTION 'access denied';
  END IF;
  IF v_insp.state NOT IN ('open','in_review') THEN
    RAISE EXCEPTION 'inspection already finalized (%)', v_insp.state;
  END IF;
  IF p_accepted_qty < 0 OR p_accepted_qty > v_insp.quantity THEN
    RAISE EXCEPTION 'accepted_qty out of range';
  END IF;

  v_state := CASE WHEN p_accepted_qty = v_insp.quantity THEN 'accepted' ELSE 'partially_accepted' END;

  UPDATE public.wms_qc_inspections
    SET state = v_state,
        accepted_qty = p_accepted_qty,
        rejected_qty = v_insp.quantity - p_accepted_qty,
        inspected_at = now(),
        inspector_id = COALESCE(v_insp.inspector_id, auth.uid()),
        notes = COALESCE(p_notes, notes)
    WHERE id = p_inspection_id
    RETURNING * INTO v_insp;

  PERFORM public.emit_qc_event('warehouse.qc.accepted', v_insp);
  RETURN v_insp;
END; $$;

GRANT EXECUTE ON FUNCTION public.accept_qc_inspection(uuid,numeric,text) TO authenticated;

-- RPC: reject_qc_inspection
CREATE OR REPLACE FUNCTION public.reject_qc_inspection(
  p_inspection_id uuid,
  p_rejected_qty numeric,
  p_disposition text,
  p_notes text DEFAULT NULL
) RETURNS public.wms_qc_inspections LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_insp public.wms_qc_inspections;
BEGIN
  SELECT * INTO v_insp FROM public.wms_qc_inspections WHERE id = p_inspection_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'inspection not found'; END IF;
  IF v_insp.business_id NOT IN (SELECT business_id FROM public.user_business_access WHERE user_id = auth.uid()) THEN
    RAISE EXCEPTION 'access denied';
  END IF;
  IF v_insp.state NOT IN ('open','in_review') THEN
    RAISE EXCEPTION 'inspection already finalized (%)', v_insp.state;
  END IF;
  IF p_disposition NOT IN ('return_to_vendor','scrap','rework','use_as_is') THEN
    RAISE EXCEPTION 'invalid disposition';
  END IF;
  IF p_rejected_qty <= 0 OR p_rejected_qty > v_insp.quantity THEN
    RAISE EXCEPTION 'rejected_qty out of range';
  END IF;

  UPDATE public.wms_qc_inspections
    SET state = 'rejected',
        rejected_qty = p_rejected_qty,
        accepted_qty = v_insp.quantity - p_rejected_qty,
        disposition = p_disposition,
        inspected_at = now(),
        inspector_id = COALESCE(v_insp.inspector_id, auth.uid()),
        notes = COALESCE(p_notes, notes)
    WHERE id = p_inspection_id
    RETURNING * INTO v_insp;

  PERFORM public.emit_qc_event('warehouse.qc.rejected', v_insp);
  RETURN v_insp;
END; $$;

GRANT EXECUTE ON FUNCTION public.reject_qc_inspection(uuid,numeric,text,text) TO authenticated;

-- RPC: cancel_qc_inspection
CREATE OR REPLACE FUNCTION public.cancel_qc_inspection(
  p_inspection_id uuid,
  p_reason text DEFAULT NULL
) RETURNS public.wms_qc_inspections LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_insp public.wms_qc_inspections;
BEGIN
  SELECT * INTO v_insp FROM public.wms_qc_inspections WHERE id = p_inspection_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'inspection not found'; END IF;
  IF v_insp.business_id NOT IN (SELECT business_id FROM public.user_business_access WHERE user_id = auth.uid()) THEN
    RAISE EXCEPTION 'access denied';
  END IF;
  IF v_insp.state IN ('accepted','partially_accepted','rejected','cancelled') THEN
    RAISE EXCEPTION 'cannot cancel finalized inspection';
  END IF;

  UPDATE public.wms_qc_inspections
    SET state = 'cancelled', cancelled_reason = p_reason
    WHERE id = p_inspection_id
    RETURNING * INTO v_insp;

  PERFORM public.emit_qc_event('warehouse.qc.cancelled', v_insp);
  RETURN v_insp;
END; $$;

GRANT EXECUTE ON FUNCTION public.cancel_qc_inspection(uuid,text) TO authenticated;
