
CREATE OR REPLACE FUNCTION public._wms_emit_receiving_line_captured()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  _sess public.wms_receiving_sessions%ROWTYPE;
BEGIN
  IF NEW.received_qty IS NULL OR NEW.received_qty <= 0 THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.received_qty IS NOT DISTINCT FROM NEW.received_qty THEN
    RETURN NEW;
  END IF;

  SELECT * INTO _sess FROM public.wms_receiving_sessions WHERE id = NEW.session_id;

  PERFORM public._wms_emit_event(
    'warehouse.receiving.line_captured',
    NEW.id,
    NEW.organization_id,
    NEW.business_id,
    NEW.warehouse_id,
    _sess.branch_id,
    NEW.captured_by,
    jsonb_build_object(
      'session_id',         NEW.session_id,
      'product_id',         NEW.product_id,
      'lpn_id',             NEW.lpn_id,
      'lot_number',         NEW.lot_number,
      'serial_number',      NEW.serial_number,
      'expected_qty',       NEW.expected_qty,
      'received_qty',       NEW.received_qty,
      'uom',                NEW.uom,
      'staging_location_id',NEW.staging_location_id,
      'source_doc_type',    _sess.source_doc_type,
      'source_doc_id',      _sess.source_doc_id,
      'appointment_id',     _sess.appointment_id,
      'dock_id',            _sess.dock_id
    ),
    'wms.receiving_line:' || NEW.id::text || ':captured',
    _sess.source_doc_type,
    _sess.source_doc_id
  );
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_wms_recv_lines_emit_captured ON public.wms_receiving_lines;
CREATE TRIGGER trg_wms_recv_lines_emit_captured
  AFTER INSERT OR UPDATE OF received_qty ON public.wms_receiving_lines
  FOR EACH ROW EXECUTE FUNCTION public._wms_emit_receiving_line_captured();
