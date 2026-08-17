-- Draft invoices carry no GL footprint (trg_invoices_require_journal only demands a
-- journal for posted statuses), so reversal semantics (ADR 0127) do not apply: there is
-- nothing to reverse. Deletion is the correct operation. This is the only sanctioned
-- delete path and proves the preconditions before touching the row.
CREATE OR REPLACE FUNCTION public.delete_draft_invoice_atomic(
  _invoice_id uuid,
  _actor uuid DEFAULT auth.uid()
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_inv         invoices%ROWTYPE;
  v_je_count    integer;
  v_alloc_count integer;
  v_cn_count    integer;
  v_released    integer := 0;
BEGIN
  SELECT * INTO v_inv FROM invoices WHERE id = _invoice_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('status', 'not_found', 'invoice_id', _invoice_id);
  END IF;

  IF v_inv.status <> 'draft'::invoice_status THEN
    RAISE EXCEPTION 'Invoice % is % — only draft invoices may be deleted; posted documents must be voided via void_invoice_atomic',
      v_inv.invoice_number, v_inv.status USING ERRCODE = '22023';
  END IF;

  SELECT count(*) INTO v_je_count FROM journal_entries WHERE source_id = _invoice_id;
  IF v_je_count > 0 THEN
    RAISE EXCEPTION 'Invoice % has % journal entr(ies) and is not a true draft; void it instead',
      v_inv.invoice_number, v_je_count USING ERRCODE = '22023';
  END IF;

  SELECT count(*) INTO v_alloc_count FROM payment_allocations WHERE invoice_id = _invoice_id;
  IF v_alloc_count > 0 THEN
    RAISE EXCEPTION 'Invoice % has % payment allocation(s); reverse the settlement first',
      v_inv.invoice_number, v_alloc_count USING ERRCODE = '22023';
  END IF;

  SELECT count(*) INTO v_cn_count FROM credit_note_applications WHERE invoice_id = _invoice_id;
  IF v_cn_count > 0 THEN
    RAISE EXCEPTION 'Invoice % has % credit-note application(s); unapply them first',
      v_inv.invoice_number, v_cn_count USING ERRCODE = '22023';
  END IF;

  -- Release 3PL billing lines so the activities become re-invoiceable.
  UPDATE wms_billable_activities SET invoice_id = NULL WHERE invoice_id = _invoice_id;
  GET DIAGNOSTICS v_released = ROW_COUNT;

  -- invoice_items / invoice_additional_costs cascade by FK.
  DELETE FROM invoices WHERE id = _invoice_id;

  INSERT INTO audit_logs (
    organization_id, business_id, user_id, action, entity_type, entity_id, entity_name,
    old_values, new_values
  ) VALUES (
    v_inv.organization_id, v_inv.business_id, _actor,
    'delete_draft_invoice', 'invoices', _invoice_id, v_inv.invoice_number,
    jsonb_build_object(
      'invoice_number', v_inv.invoice_number,
      'status', v_inv.status,
      'total', v_inv.total,
      'currency', v_inv.currency
    ),
    jsonb_build_object('billing_lines_released', v_released)
  );

  RETURN jsonb_build_object(
    'status', 'deleted',
    'invoice_id', _invoice_id,
    'invoice_number', v_inv.invoice_number,
    'billing_lines_released', v_released
  );
END;
$$;

REVOKE ALL ON FUNCTION public.delete_draft_invoice_atomic(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.delete_draft_invoice_atomic(uuid, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.delete_draft_invoice_atomic(uuid, uuid) TO service_role;

-- Remove the mis-priced simulation draft (no GL rows, no payments).
SELECT public.delete_draft_invoice_atomic(
  '3fb27424-a728-47ca-9c67-ba770b670abc'::uuid,
  NULL
);