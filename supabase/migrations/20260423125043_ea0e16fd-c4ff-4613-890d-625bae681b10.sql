-- =========================================================================
-- Sales Audit Refinement — Phase A/B/C
-- =========================================================================

-- A1. Add reversal_journal_entry_id link on invoices
ALTER TABLE public.invoices
  ADD COLUMN IF NOT EXISTS reversal_journal_entry_id uuid
    REFERENCES public.journal_entries(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_invoices_reversal_je
  ON public.invoices(reversal_journal_entry_id)
  WHERE reversal_journal_entry_id IS NOT NULL;

-- =========================================================================
-- A2. restore_invoice_stock_atomic RPC
--     Mirrors original sale stock_movements as return_in rows in one txn.
-- =========================================================================
CREATE OR REPLACE FUNCTION public.restore_invoice_stock_atomic(
  p_invoice_id uuid,
  p_user_id uuid,
  p_reason text DEFAULT 'Invoice voided'
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_invoice record;
  v_count integer := 0;
  v_already integer := 0;
BEGIN
  SELECT id, organization_id, business_id, branch_id, invoice_number
    INTO v_invoice
  FROM public.invoices
  WHERE id = p_invoice_id;

  IF v_invoice.id IS NULL THEN
    RAISE EXCEPTION 'Invoice % not found', p_invoice_id USING ERRCODE = 'no_data_found';
  END IF;

  -- Auth: caller must access this business
  IF NOT public.user_can_access_business(p_user_id, v_invoice.business_id) THEN
    RAISE EXCEPTION 'User % cannot access business %', p_user_id, v_invoice.business_id
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- Idempotency: if return_in moves already exist for this invoice, no-op.
  SELECT count(*) INTO v_already
  FROM public.stock_movements
  WHERE reference_type = 'invoice_void' AND reference_id = p_invoice_id;
  IF v_already > 0 THEN
    RETURN 0;
  END IF;

  -- Mirror each original sale movement as a return_in
  WITH ins AS (
    INSERT INTO public.stock_movements (
      organization_id, business_id, branch_id, warehouse_id,
      product_id, movement_type, quantity, unit_cost,
      reference_type, reference_id, notes, created_by
    )
    SELECT
      sm.organization_id,
      sm.business_id,
      sm.branch_id,
      sm.warehouse_id,
      sm.product_id,
      'return_in',
      sm.quantity,
      sm.unit_cost,
      'invoice_void',
      p_invoice_id,
      'Stock restored — Invoice ' || v_invoice.invoice_number || ' voided. ' || COALESCE(p_reason, ''),
      p_user_id
    FROM public.stock_movements sm
    JOIN public.products p ON p.id = sm.product_id
    WHERE sm.reference_type = 'invoice'
      AND sm.reference_id = p_invoice_id
      AND p.track_inventory = true
    RETURNING 1
  )
  SELECT count(*) INTO v_count FROM ins;

  RETURN v_count;
END;
$$;

GRANT EXECUTE ON FUNCTION public.restore_invoice_stock_atomic(uuid, uuid, text) TO authenticated;

COMMENT ON FUNCTION public.restore_invoice_stock_atomic(uuid, uuid, text) IS
  'Atomically restores stock for a voided invoice by mirroring original sale movements as return_in. Idempotent. Auth: user_can_access_business.';

-- =========================================================================
-- B5. Enforce delivery note contact ↔ business match
-- =========================================================================
CREATE OR REPLACE FUNCTION public.enforce_delivery_note_contact_business_match()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_contact_business uuid;
  v_so_business uuid;
BEGIN
  IF NEW.contact_id IS NOT NULL THEN
    SELECT business_id INTO v_contact_business FROM public.contacts WHERE id = NEW.contact_id;
    IF v_contact_business IS NOT NULL AND v_contact_business <> NEW.business_id THEN
      RAISE EXCEPTION 'Delivery note business_id (%) does not match contact business_id (%)',
        NEW.business_id, v_contact_business
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  IF NEW.sales_order_id IS NOT NULL THEN
    SELECT business_id INTO v_so_business FROM public.sales_orders WHERE id = NEW.sales_order_id;
    IF v_so_business IS NOT NULL AND v_so_business <> NEW.business_id THEN
      RAISE EXCEPTION 'Delivery note business_id (%) does not match sales order business_id (%)',
        NEW.business_id, v_so_business
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS enforce_delivery_note_contact_business_match ON public.delivery_notes;
CREATE TRIGGER enforce_delivery_note_contact_business_match
  BEFORE INSERT OR UPDATE OF contact_id, sales_order_id, business_id ON public.delivery_notes
  FOR EACH ROW EXECUTE FUNCTION public.enforce_delivery_note_contact_business_match();

-- =========================================================================
-- C9. Tighten get_sales_dashboard_kpis — explicitly exclude voided/cancelled,
--     and add posted_revenue keyed off confirmed_at.
-- =========================================================================
CREATE OR REPLACE FUNCTION public.get_sales_dashboard_kpis(
  p_org_id uuid,
  p_business_id uuid,
  p_branch_id uuid,
  p_date_from date,
  p_date_to date
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_total_revenue numeric := 0;
  v_posted_revenue numeric := 0;
  v_outstanding numeric := 0;
  v_overdue numeric := 0;
  v_paid_count integer := 0;
  v_total_count integer := 0;
  v_draft_count integer := 0;
  v_avg_invoice numeric := 0;
BEGIN
  SELECT
    -- total_revenue: confirmed/posted invoices, exclude draft/voided/cancelled
    COALESCE(SUM(CASE
      WHEN status IN ('paid','partial','sent','viewed','overdue','confirmed')
       AND status NOT IN ('voided','cancelled','draft')
      THEN total ELSE 0 END), 0),
    -- posted_revenue: only invoices that have actually been confirmed (JE posted)
    COALESCE(SUM(CASE
      WHEN confirmed_at IS NOT NULL
       AND status NOT IN ('voided','cancelled','draft')
      THEN total ELSE 0 END), 0),
    COALESCE(SUM(CASE
      WHEN status IN ('sent','viewed','partial','overdue','confirmed')
      THEN GREATEST(total - COALESCE(amount_paid,0),0) ELSE 0 END), 0),
    COALESCE(SUM(CASE
      WHEN status='overdue'
        OR (status IN ('sent','viewed','partial','confirmed') AND due_date < CURRENT_DATE)
      THEN GREATEST(total - COALESCE(amount_paid,0),0) ELSE 0 END), 0),
    COALESCE(SUM(CASE WHEN status='paid' THEN 1 ELSE 0 END), 0),
    COUNT(*),
    COALESCE(SUM(CASE WHEN status='draft' THEN 1 ELSE 0 END), 0)
  INTO v_total_revenue, v_posted_revenue, v_outstanding, v_overdue, v_paid_count, v_total_count, v_draft_count
  FROM public.invoices
  WHERE organization_id = p_org_id
    AND business_id = p_business_id
    AND issue_date BETWEEN p_date_from AND p_date_to
    AND (p_branch_id IS NULL OR branch_id = p_branch_id OR branch_id IS NULL);

  IF v_total_count > 0 THEN
    v_avg_invoice := v_total_revenue / v_total_count;
  END IF;

  RETURN jsonb_build_object(
    'total_revenue', v_total_revenue,
    'posted_revenue', v_posted_revenue,
    'outstanding', v_outstanding,
    'overdue', v_overdue,
    'paid_count', v_paid_count,
    'total_count', v_total_count,
    'draft_count', v_draft_count,
    'avg_invoice', v_avg_invoice
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_sales_dashboard_kpis(uuid, uuid, uuid, date, date) TO authenticated;

COMMENT ON FUNCTION public.get_sales_dashboard_kpis(uuid, uuid, uuid, date, date) IS
  'Sales dashboard KPIs. Excludes voided/cancelled/draft from revenue. Adds posted_revenue keyed off confirmed_at. Cache-bust 2026-04-23 audit.';