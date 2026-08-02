-- =====================================================================
-- Returns Phase 6.3 — credit-note back-linkage (Finance -> Warehouse)
-- =====================================================================
CREATE OR REPLACE FUNCTION public._wms_backlink_return_credit_note()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_ord public.wms_return_orders%ROWTYPE;
  v_branch uuid;
  v_new_version integer;
BEGIN
  IF NEW.source_return_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT * INTO v_ord
    FROM public.wms_return_orders
   WHERE finance_doc_type = 'sales_return'
     AND finance_doc_id = NEW.source_return_id
   FOR UPDATE;

  IF v_ord.id IS NULL THEN
    RETURN NEW;
  END IF;

  -- Idempotent: nothing to do when the link is already current.
  IF v_ord.credit_note_id IS NOT DISTINCT FROM NEW.id THEN
    RETURN NEW;
  END IF;

  v_branch := COALESCE(v_ord.branch_id,
                       (SELECT branch_id FROM public.warehouses WHERE id = v_ord.warehouse_id));
  v_new_version := v_ord.row_version + 1;

  UPDATE public.wms_return_orders
     SET credit_note_id = NEW.id,
         row_version    = v_new_version,
         updated_at     = now()
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
        'finance_doc_type', v_ord.finance_doc_type,
        'finance_doc_id', v_ord.finance_doc_id,
        'credit_note_id', NEW.id,
        'source', 'credit_note_trigger'
      )
    )
  );

  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_wms_backlink_return_credit_note ON public.credit_notes;
CREATE TRIGGER trg_wms_backlink_return_credit_note
AFTER INSERT OR UPDATE OF source_return_id ON public.credit_notes
FOR EACH ROW EXECUTE FUNCTION public._wms_backlink_return_credit_note();

-- =====================================================================
-- Returns Phase 6.4 — returns paperwork template seeding
-- =====================================================================
CREATE OR REPLACE FUNCTION public.wms_seed_returns_document_templates(
  _org_id uuid,
  _business_id uuid,
  _actor uuid DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  r record;
BEGIN
  IF _org_id IS NULL OR _business_id IS NULL THEN
    RAISE EXCEPTION 'org and business are required' USING ERRCODE = '22023';
  END IF;

  FOR r IN
    SELECT * FROM (VALUES
      ('return_authorization', 'RMA Authorization (WMS)',  'RETURN MERCHANDISE AUTHORIZATION'),
      ('return_receipt',       'Return Receipt (WMS)',     'RETURN RECEIPT'),
      ('return_inspection',    'Inspection Report (WMS)',  'RETURN INSPECTION REPORT'),
      ('return_damage',        'Damage Report (WMS)',      'RETURN DAMAGE REPORT')
    ) AS t(template_type, template_name, title)
  LOOP
    IF EXISTS (
      SELECT 1 FROM public.document_templates
       WHERE organization_id = _org_id
         AND business_id = _business_id
         AND template_type = r.template_type
    ) THEN
      CONTINUE;
    END IF;

    INSERT INTO public.document_templates (
      organization_id, business_id, template_type, template_name,
      is_default, is_active, document_title_format,
      show_item_sku, show_unit_price, show_tax_column, show_discount_column,
      show_subtotals_per_item, show_subtotal, show_discount_total,
      show_tax_breakdown, show_total_in_words,
      show_payment_instructions, show_bank_details, show_payment_methods,
      show_signature_line, signature_label, show_status_badge,
      columns_layout, created_by
    ) VALUES (
      _org_id, _business_id, r.template_type, r.template_name,
      true, true, r.title,
      true, false, false, false,
      false, false, false,
      false, false,
      false, false, false,
      true, 'Warehouse Operator', true,
      '{"description": 70, "quantity": 30}'::jsonb, _actor
    );
  END LOOP;
END $$;

GRANT EXECUTE ON FUNCTION public.wms_seed_returns_document_templates(uuid, uuid, uuid) TO authenticated;
