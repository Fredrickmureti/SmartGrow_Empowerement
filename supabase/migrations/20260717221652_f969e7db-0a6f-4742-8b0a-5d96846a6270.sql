-- Phase 7.1 continued — auto-open QC on GRN completion

-- 1) Product-level QC flag.
ALTER TABLE public.products
  ADD COLUMN IF NOT EXISTS requires_qc boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.products.requires_qc IS
  'When true, GRN completion auto-opens a QC inspection and parks received qty in Quarantine.';

-- 2) Trigger function: on goods_receipts.status → completed, open a QC
--    inspection for each line whose product requires QC.
CREATE OR REPLACE FUNCTION public._wms_auto_open_qc_on_grn()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_line record;
  v_insp public.wms_qc_inspections;
  v_hold uuid;
  v_source uuid;
BEGIN
  IF NEW.status IS DISTINCT FROM 'completed' OR OLD.status = 'completed' THEN
    RETURN NEW;
  END IF;
  IF NEW.warehouse_id IS NULL THEN RETURN NEW; END IF;

  FOR v_line IN
    SELECT gri.id AS line_id, gri.product_id, gri.quantity_received,
           gri.lot_number, gri.serial_number, p.requires_qc
      FROM public.goods_receipt_items gri
      JOIN public.products p ON p.id = gri.product_id
     WHERE gri.goods_receipt_id = NEW.id
       AND gri.qc_inspection_id IS NULL
       AND COALESCE(p.requires_qc, false) = true
       AND COALESCE(gri.quantity_received, 0) > 0
  LOOP
    INSERT INTO public.wms_qc_inspections (
      organization_id, business_id, warehouse_id, branch_id,
      source_doc_type, source_doc_id, product_id, quantity,
      lot_number, serial_number, sample_strategy, sample_size,
      state, created_by
    ) VALUES (
      NEW.organization_id, NEW.business_id, NEW.warehouse_id, NEW.branch_id,
      'goods_receipt', NEW.id, v_line.product_id, v_line.quantity_received,
      v_line.lot_number, v_line.serial_number, 'full', 0,
      'open', COALESCE(auth.uid(), NEW.created_by)
    ) RETURNING * INTO v_insp;

    UPDATE public.goods_receipt_items
       SET qc_inspection_id = v_insp.id
     WHERE id = v_line.line_id;

    -- Move the received qty STOCK → QUARANTINE.
    v_hold := public._wms_ensure_qc_hold(NEW.warehouse_id);
    v_source := public._wms_default_putaway(NEW.warehouse_id);
    PERFORM public._wms_qc_post_move(
      v_insp, v_source, v_hold, v_line.quantity_received,
      'qc_hold', 'Auto QC hold on GRN ' || NEW.receipt_number
    );

    PERFORM public.emit_qc_event('warehouse.qc.opened', v_insp);
  END LOOP;

  RETURN NEW;
END; $$;

DROP TRIGGER IF EXISTS trg_wms_auto_open_qc_on_grn ON public.goods_receipts;
CREATE TRIGGER trg_wms_auto_open_qc_on_grn
  AFTER UPDATE OF status ON public.goods_receipts
  FOR EACH ROW
  EXECUTE FUNCTION public._wms_auto_open_qc_on_grn();