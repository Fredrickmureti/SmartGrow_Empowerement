-- =====================================================================
-- Invoice → AR: one accounting engine
-- =====================================================================

-- ---------------------------------------------------------------
-- 1. Canonical AR / AP summaries (GL-gated projections)
-- ---------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_ar_summary(
  _org_id uuid,
  _business_id uuid DEFAULT NULL,
  _branch_id uuid DEFAULT NULL,
  _as_of date DEFAULT CURRENT_DATE
)
RETURNS TABLE (
  open_document_count integer,
  total_residual numeric,
  not_due numeric,
  current_bucket numeric,
  days30 numeric,
  days60 numeric,
  days90 numeric,
  overdue_count integer,
  unposted_document_count integer,
  unposted_amount numeric
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  WITH open_items AS (
    SELECT o.*,
           GREATEST(0, (_as_of - COALESCE(o.due_date, o.document_date)))::int AS days_past_due
      FROM public.finance_ar_open_items o
     WHERE o.organization_id = _org_id
       AND (_business_id IS NULL OR o.business_id = _business_id)
       AND (_branch_id IS NULL OR o.branch_id = _branch_id)
       AND o.document_date <= _as_of
       AND o.residual_amount > 0.01
  ),
  unposted AS (
    SELECT COUNT(*)::int AS cnt,
           COALESCE(SUM(GREATEST(0, COALESCE(i.total,0) - COALESCE(i.amount_paid,0))), 0) AS amt
      FROM public.invoices i
     WHERE i.organization_id = _org_id
       AND (_business_id IS NULL OR i.business_id = _business_id)
       AND (_branch_id IS NULL OR i.branch_id = _branch_id)
       AND i.status NOT IN ('draft', 'cancelled', 'voided', 'paid')
       AND NOT EXISTS (
         SELECT 1 FROM public.journal_entries je
          WHERE je.source_type = 'invoice'
            AND je.source_id = i.id
            AND je.status = 'posted'
       )
  )
  SELECT
    (SELECT COUNT(*)::int FROM open_items),
    (SELECT COALESCE(SUM(residual_amount), 0) FROM open_items),
    (SELECT COALESCE(SUM(residual_amount), 0) FROM open_items WHERE COALESCE(due_date, document_date) > _as_of),
    (SELECT COALESCE(SUM(residual_amount), 0) FROM open_items WHERE days_past_due BETWEEN 0 AND 30 AND COALESCE(due_date, document_date) <= _as_of),
    (SELECT COALESCE(SUM(residual_amount), 0) FROM open_items WHERE days_past_due BETWEEN 31 AND 60),
    (SELECT COALESCE(SUM(residual_amount), 0) FROM open_items WHERE days_past_due BETWEEN 61 AND 90),
    (SELECT COALESCE(SUM(residual_amount), 0) FROM open_items WHERE days_past_due > 90),
    (SELECT COUNT(*)::int FROM open_items WHERE COALESCE(due_date, document_date) < _as_of),
    (SELECT cnt FROM unposted),
    (SELECT amt FROM unposted)
$$;

CREATE OR REPLACE FUNCTION public.get_ap_summary(
  _org_id uuid,
  _business_id uuid DEFAULT NULL,
  _branch_id uuid DEFAULT NULL,
  _as_of date DEFAULT CURRENT_DATE
)
RETURNS TABLE (
  open_document_count integer,
  total_residual numeric,
  not_due numeric,
  current_bucket numeric,
  days30 numeric,
  days60 numeric,
  days90 numeric,
  overdue_count integer,
  unposted_document_count integer,
  unposted_amount numeric
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  WITH open_items AS (
    SELECT o.*,
           GREATEST(0, (_as_of - COALESCE(o.due_date, o.document_date)))::int AS days_past_due
      FROM public.finance_ap_open_items o
     WHERE o.organization_id = _org_id
       AND (_business_id IS NULL OR o.business_id = _business_id)
       AND (_branch_id IS NULL OR o.branch_id = _branch_id)
       AND o.document_date <= _as_of
       AND o.residual_amount > 0.01
  ),
  unposted AS (
    SELECT COUNT(*)::int AS cnt,
           COALESCE(SUM(GREATEST(0, COALESCE(b.total,0) - COALESCE(b.amount_paid,0))), 0) AS amt
      FROM public.bills b
     WHERE b.organization_id = _org_id
       AND (_business_id IS NULL OR b.business_id = _business_id)
       AND (_branch_id IS NULL OR b.branch_id = _branch_id)
       AND b.status::text NOT IN ('draft', 'cancelled', 'voided', 'paid')
       AND NOT EXISTS (
         SELECT 1 FROM public.journal_entries je
          WHERE je.source_type = 'bill'
            AND je.source_id = b.id
            AND je.status = 'posted'
       )
  )
  SELECT
    (SELECT COUNT(*)::int FROM open_items),
    (SELECT COALESCE(SUM(residual_amount), 0) FROM open_items),
    (SELECT COALESCE(SUM(residual_amount), 0) FROM open_items WHERE COALESCE(due_date, document_date) > _as_of),
    (SELECT COALESCE(SUM(residual_amount), 0) FROM open_items WHERE days_past_due BETWEEN 0 AND 30 AND COALESCE(due_date, document_date) <= _as_of),
    (SELECT COALESCE(SUM(residual_amount), 0) FROM open_items WHERE days_past_due BETWEEN 31 AND 60),
    (SELECT COALESCE(SUM(residual_amount), 0) FROM open_items WHERE days_past_due BETWEEN 61 AND 90),
    (SELECT COALESCE(SUM(residual_amount), 0) FROM open_items WHERE days_past_due > 90),
    (SELECT COUNT(*)::int FROM open_items WHERE COALESCE(due_date, document_date) < _as_of),
    (SELECT cnt FROM unposted),
    (SELECT amt FROM unposted)
$$;

GRANT EXECUTE ON FUNCTION public.get_ar_summary(uuid, uuid, uuid, date) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_ap_summary(uuid, uuid, uuid, date) TO authenticated;

-- ---------------------------------------------------------------
-- 2. Atomic final status on invoice confirmation
-- ---------------------------------------------------------------
DROP FUNCTION IF EXISTS public.confirm_invoice_atomic(uuid, uuid, jsonb);

CREATE OR REPLACE FUNCTION public.confirm_invoice_atomic(
  p_invoice_id uuid,
  p_user_id uuid,
  p_main_lines jsonb,
  p_final_status text DEFAULT 'confirmed'
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_inv record; v_je_id uuid; v_main_entry_no text;
  v_line_count integer; v_items_subtotal numeric := 0; v_items_tax numeric := 0;
  v_main_debits numeric := 0; v_main_credits numeric := 0;
  v_bad_accounts integer := 0; v_revenue_line_count integer := 0;
  v_ar_line_count integer := 0;
  v_existing_dn_id uuid; v_stockable_count integer := 0;
  v_dn_id uuid; v_dn_number text;
  v_final text := COALESCE(NULLIF(p_final_status, ''), 'confirmed');
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'auth required' USING ERRCODE = '42501'; END IF;
  IF v_final NOT IN ('confirmed', 'sent') THEN
    RAISE EXCEPTION 'Invalid post-confirmation status %; expected confirmed or sent', v_final;
  END IF;

  SELECT * INTO v_inv FROM public.invoices WHERE id = p_invoice_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Invoice % not found', p_invoice_id; END IF;
  IF v_inv.status <> 'draft' THEN
    RAISE EXCEPTION 'Only draft invoices can be confirmed (current: %)', v_inv.status;
  END IF;
  IF v_inv.contact_id IS NULL THEN
    RAISE EXCEPTION 'A customer is required to confirm this invoice. Please select a customer and try again.'
      USING ERRCODE = 'check_violation';
  END IF;
  IF v_inv.business_id IS NULL OR NOT public.user_can_access_business(p_user_id, v_inv.business_id) THEN
    RAISE EXCEPTION 'Access denied for business %', v_inv.business_id USING ERRCODE = '42501';
  END IF;
  IF v_inv.journal_entry_id IS NOT NULL THEN
    RAISE EXCEPTION 'Invoice % is already linked to a journal entry', v_inv.invoice_number;
  END IF;

  PERFORM public.assert_contact_in_business(v_inv.contact_id, v_inv.organization_id, v_inv.business_id, 'invoice customer');
  PERFORM public.assert_no_existing_source_posting(v_inv.organization_id, 'invoice', p_invoice_id, NULL);

  IF p_main_lines IS NULL OR jsonb_typeof(p_main_lines) <> 'array' OR jsonb_array_length(p_main_lines) < 2 THEN
    RAISE EXCEPTION 'Invoice JE requires at least 2 lines';
  END IF;

  SELECT COUNT(*), COALESCE(ROUND(SUM(line_total), 2), 0), COALESCE(ROUND(SUM(COALESCE(tax_amount, 0)), 2), 0)
    INTO v_line_count, v_items_subtotal, v_items_tax
  FROM public.invoice_items WHERE invoice_id = p_invoice_id;
  IF v_line_count = 0 THEN RAISE EXCEPTION 'Invoice % has no lines; cannot confirm', v_inv.invoice_number; END IF;
  IF ABS(v_items_subtotal - COALESCE(v_inv.subtotal, 0)) > 0.01
     OR ABS(v_items_tax - COALESCE(v_inv.tax_amount, 0)) > 0.01
     OR ABS(ROUND(v_items_subtotal + v_items_tax - COALESCE(v_inv.discount_amount, 0), 2) - COALESCE(v_inv.total, 0)) > 0.01 THEN
    RAISE EXCEPTION 'Invoice % totals do not match persisted line data', v_inv.invoice_number;
  END IF;

  SELECT
    COALESCE(SUM((l->>'debit')::numeric), 0),
    COALESCE(SUM((l->>'credit')::numeric), 0),
    COUNT(*) FILTER (WHERE a.id IS NULL),
    COUNT(*) FILTER (WHERE a.account_type = 'income' AND (l->>'credit')::numeric > 0),
    COUNT(*) FILTER (WHERE a.account_type = 'asset' AND a.detail_type = 'accounts_receivable' AND (l->>'debit')::numeric > 0)
  INTO v_main_debits, v_main_credits, v_bad_accounts, v_revenue_line_count, v_ar_line_count
  FROM jsonb_array_elements(p_main_lines) l
  LEFT JOIN public.accounts a ON a.id = (l->>'account_id')::uuid
                              AND a.organization_id = v_inv.organization_id
                              AND a.business_id = v_inv.business_id;

  IF v_bad_accounts > 0 THEN RAISE EXCEPTION 'Invoice JE references % accounts not in this business', v_bad_accounts; END IF;
  IF ABS(v_main_debits - v_main_credits) > 0.01 THEN RAISE EXCEPTION 'Invoice JE not balanced: debits % credits %', v_main_debits, v_main_credits; END IF;
  IF v_revenue_line_count = 0 OR v_ar_line_count = 0 THEN RAISE EXCEPTION 'Invoice JE missing required AR or Revenue line'; END IF;

  SELECT public.get_next_journal_entry_number(v_inv.organization_id) INTO v_main_entry_no;
  v_je_id := public.post_journal_entry_atomic(
    _org_id := v_inv.organization_id, _business_id := v_inv.business_id,
    _entry_number := v_main_entry_no, _entry_date := v_inv.issue_date,
    _reference := v_inv.invoice_number, _description := 'Invoice ' || v_inv.invoice_number,
    _source_type := 'invoice', _source_id := p_invoice_id,
    _created_by := p_user_id, _is_closing := false, _is_adjusting := false,
    _lines := p_main_lines, _currency := v_inv.currency,
    _exchange_rate := NULL, _source_subtype := NULL, _branch_id := v_inv.branch_id
  );

  -- Status flip + JE link in the same transaction as the posting.
  UPDATE public.invoices
    SET status = v_final::invoice_status, journal_entry_id = v_je_id, updated_at = now()
   WHERE id = p_invoice_id;

  IF v_inv.source_sales_order_id IS NULL THEN
    SELECT id INTO v_existing_dn_id FROM public.delivery_notes
      WHERE source_invoice_id = p_invoice_id LIMIT 1;

    IF v_existing_dn_id IS NULL THEN
      SELECT COUNT(*) INTO v_stockable_count
        FROM public.invoice_items ii
        JOIN public.products p ON p.id = ii.product_id
       WHERE ii.invoice_id = p_invoice_id
         AND COALESCE(p.track_inventory, true) = true
         AND p.type = 'product'
         AND COALESCE(ii.quantity, 0) > 0;

      IF v_stockable_count > 0 THEN
        v_dn_number := public.get_next_delivery_number(v_inv.organization_id);
        INSERT INTO public.delivery_notes (
          organization_id, business_id, branch_id,
          contact_id, delivery_number, delivery_date, status,
          sales_order_id, source_invoice_id, received_by_contact_id,
          notes, created_by
        ) VALUES (
          v_inv.organization_id, v_inv.business_id, v_inv.branch_id,
          v_inv.contact_id, v_dn_number, v_inv.issue_date, 'pending',
          NULL, p_invoice_id, v_inv.contact_id, NULL, p_user_id
        ) RETURNING id INTO v_dn_id;

        INSERT INTO public.delivery_note_items (
          delivery_note_id, product_id, description,
          quantity_ordered, quantity_delivered, sort_order,
          lot_number, serial_number
        )
        SELECT
          v_dn_id, ii.product_id, ii.description,
          ii.quantity, ii.quantity, COALESCE(ii.sort_order, 0),
          ii.lot_number, ii.serial_number
        FROM public.invoice_items ii
        JOIN public.products p ON p.id = ii.product_id
       WHERE ii.invoice_id = p_invoice_id
         AND COALESCE(p.track_inventory, true) = true
         AND p.type = 'product'
         AND COALESCE(ii.quantity, 0) > 0;
      END IF;
    END IF;
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'journal_entry_id', v_je_id,
    'invoice_status', v_final,
    'delivery_note_id', v_dn_id,
    'delivery_number', v_dn_number,
    'auto_delivery_created', v_dn_id IS NOT NULL
  );
END;
$fn$;

GRANT EXECUTE ON FUNCTION public.confirm_invoice_atomic(uuid, uuid, jsonb, text) TO authenticated;

CREATE OR REPLACE FUNCTION public.confirm_invoice_and_release_stock_atomic(
  p_invoice_id uuid,
  p_user_id uuid,
  p_main_lines jsonb,
  p_release_stock boolean DEFAULT true,
  p_warehouse_id uuid DEFAULT NULL,
  p_final_status text DEFAULT 'confirmed'
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_confirm  jsonb;
  v_dn_id    uuid;
  v_delivery jsonb;
BEGIN
  v_confirm := public.confirm_invoice_atomic(
    p_invoice_id  := p_invoice_id,
    p_user_id     := p_user_id,
    p_main_lines  := p_main_lines,
    p_final_status := p_final_status
  );

  v_dn_id := NULLIF(v_confirm->>'delivery_note_id', '')::uuid;

  IF v_dn_id IS NULL THEN
    SELECT dn.id INTO v_dn_id
      FROM public.delivery_notes dn
      JOIN public.invoices i ON i.id = p_invoice_id
     WHERE dn.organization_id = i.organization_id
       AND dn.business_id     = i.business_id
       AND (
         dn.source_invoice_id = p_invoice_id
         OR (i.source_sales_order_id IS NOT NULL AND dn.sales_order_id = i.source_sales_order_id)
       )
       AND dn.status = 'pending'
     ORDER BY dn.created_at DESC
     LIMIT 1;
  END IF;

  IF p_release_stock AND v_dn_id IS NOT NULL THEN
    v_delivery := public.complete_delivery_atomic(
      p_dn_id               := v_dn_id,
      p_user_id             := p_user_id,
      p_received_by         := NULL,
      p_pod                 := NULL,
      p_received_by_user_id := p_user_id
    );
    IF NOT COALESCE((v_delivery->>'success')::boolean, false) THEN
      RAISE EXCEPTION 'Stock release failed: %', COALESCE(v_delivery->>'error', 'unknown error');
    END IF;
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'journal_entry_id', v_confirm->>'journal_entry_id',
    'invoice_status', v_confirm->>'invoice_status',
    'delivery_note_id', v_dn_id,
    'auto_delivery_created', COALESCE((v_confirm->>'auto_delivery_created')::boolean, false),
    'stock_released', p_release_stock AND v_dn_id IS NOT NULL,
    'delivery_result', v_delivery
  );
END;
$fn$;

GRANT EXECUTE ON FUNCTION public.confirm_invoice_and_release_stock_atomic(uuid, uuid, jsonb, boolean, uuid, text) TO authenticated;

-- ---------------------------------------------------------------
-- 3. Invariant: no non-draft invoice without a posted journal entry
-- ---------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.enforce_invoice_requires_journal()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_has_je boolean;
BEGIN
  -- Historical/opening-balance loads are exempt (they post their own GL or
  -- are represented by an aggregate opening journal).
  IF COALESCE(NEW.source, '') = 'migration'
     OR NEW.migration_session_id IS NOT NULL
     OR COALESCE(current_setting('app.allow_unposted_invoice', true), '') = 'on' THEN
    RETURN NEW;
  END IF;

  IF NEW.status = 'draft' THEN
    RETURN NEW;
  END IF;

  -- Only guard the transition into an accounting-visible state. Legacy rows
  -- that were already non-draft without a journal stay editable so they can
  -- be repaired rather than frozen.
  IF TG_OP = 'UPDATE' AND OLD.status <> 'draft' THEN
    RETURN NEW;
  END IF;

  v_has_je := NEW.journal_entry_id IS NOT NULL
    OR EXISTS (
      SELECT 1 FROM public.journal_entries je
       WHERE je.source_type = 'invoice' AND je.source_id = NEW.id AND je.status = 'posted'
    );

  IF NOT v_has_je THEN
    RAISE EXCEPTION
      'Invoice % cannot become % without a posted journal entry. Confirm it through confirm_invoice_atomic.',
      COALESCE(NEW.invoice_number, NEW.id::text), NEW.status
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$fn$;

DROP TRIGGER IF EXISTS trg_invoices_require_journal ON public.invoices;
CREATE TRIGGER trg_invoices_require_journal
  BEFORE INSERT OR UPDATE OF status ON public.invoices
  FOR EACH ROW EXECUTE FUNCTION public.enforce_invoice_requires_journal();

-- ---------------------------------------------------------------
-- 4. Integrity detector + repair
-- ---------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.list_invoices_missing_journals(
  _org_id uuid,
  _business_id uuid DEFAULT NULL,
  _branch_id uuid DEFAULT NULL,
  _limit integer DEFAULT 100,
  _offset integer DEFAULT 0
)
RETURNS TABLE (
  invoice_id uuid,
  invoice_number text,
  issue_date date,
  status text,
  contact_id uuid,
  contact_name text,
  total numeric,
  amount_paid numeric,
  residual numeric
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  SELECT i.id, i.invoice_number, i.issue_date, i.status::text,
         i.contact_id, c.name, COALESCE(i.total, 0), COALESCE(i.amount_paid, 0),
         GREATEST(0, COALESCE(i.total,0) - COALESCE(i.amount_paid,0))
    FROM public.invoices i
    LEFT JOIN public.contacts c ON c.id = i.contact_id
   WHERE i.organization_id = _org_id
     AND (_business_id IS NULL OR i.business_id = _business_id)
     AND (_branch_id IS NULL OR i.branch_id = _branch_id)
     AND i.status NOT IN ('draft', 'cancelled', 'voided')
     AND NOT EXISTS (
       SELECT 1 FROM public.journal_entries je
        WHERE je.source_type = 'invoice' AND je.source_id = i.id AND je.status = 'posted'
     )
   ORDER BY i.issue_date DESC
   LIMIT GREATEST(1, LEAST(COALESCE(_limit, 100), 500))
  OFFSET GREATEST(0, COALESCE(_offset, 0))
$$;

GRANT EXECUTE ON FUNCTION public.list_invoices_missing_journals(uuid, uuid, uuid, integer, integer) TO authenticated;

CREATE OR REPLACE FUNCTION public.post_missing_invoice_journals(
  _org_id uuid,
  _business_id uuid,
  _branch_id uuid DEFAULT NULL,
  _limit integer DEFAULT 25
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_uid uuid := auth.uid();
  v_inv record;
  v_ar uuid; v_rev uuid; v_tax uuid;
  v_lines jsonb; v_je_id uuid; v_no text;
  v_posted integer := 0; v_failed integer := 0;
  v_errors jsonb := '[]'::jsonb;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'auth required' USING ERRCODE = '42501'; END IF;
  IF _business_id IS NULL OR NOT public.user_can_access_business(v_uid, _business_id) THEN
    RAISE EXCEPTION 'Access denied for business %', _business_id USING ERRCODE = '42501';
  END IF;

  v_ar  := public.get_default_account_id(_org_id, _business_id, 'accounts_receivable');
  v_rev := public.get_default_account_id(_org_id, _business_id, 'sales_revenue');
  v_tax := public.get_default_account_id(_org_id, _business_id, 'tax_payable');

  IF v_ar IS NULL OR v_rev IS NULL THEN
    RAISE EXCEPTION 'Accounts Receivable and Sales Revenue must be mapped in Settings > Default Accounts before repairing invoices';
  END IF;

  FOR v_inv IN
    SELECT i.*
      FROM public.invoices i
     WHERE i.organization_id = _org_id
       AND i.business_id = _business_id
       AND (_branch_id IS NULL OR i.branch_id = _branch_id)
       AND i.status NOT IN ('draft', 'cancelled', 'voided')
       AND i.contact_id IS NOT NULL
       AND NOT EXISTS (
         SELECT 1 FROM public.journal_entries je
          WHERE je.source_type = 'invoice' AND je.source_id = i.id AND je.status = 'posted'
       )
     ORDER BY i.issue_date
     LIMIT GREATEST(1, LEAST(COALESCE(_limit, 25), 200))
  LOOP
    BEGIN
      v_lines := jsonb_build_array(
        jsonb_build_object('account_id', v_ar, 'debit', COALESCE(v_inv.total, 0), 'credit', 0,
                           'description', 'Invoice ' || v_inv.invoice_number || ' - Accounts Receivable',
                           'contact_id', v_inv.contact_id),
        jsonb_build_object('account_id', v_rev, 'debit', 0,
                           'credit', COALESCE(v_inv.total, 0) - COALESCE(v_inv.tax_amount, 0),
                           'description', 'Invoice ' || v_inv.invoice_number || ' - Sales Revenue')
      );
      IF COALESCE(v_inv.tax_amount, 0) > 0 AND v_tax IS NOT NULL THEN
        v_lines := v_lines || jsonb_build_array(
          jsonb_build_object('account_id', v_tax, 'debit', 0, 'credit', v_inv.tax_amount,
                             'description', 'Invoice ' || v_inv.invoice_number || ' - Tax Liability'));
      ELSIF COALESCE(v_inv.tax_amount, 0) > 0 THEN
        RAISE EXCEPTION 'Tax account not mapped; cannot repair invoice %', v_inv.invoice_number;
      END IF;

      SELECT public.get_next_journal_entry_number(_org_id) INTO v_no;
      v_je_id := public.post_journal_entry_atomic(
        _org_id := _org_id, _business_id := _business_id,
        _entry_number := v_no, _entry_date := v_inv.issue_date,
        _reference := v_inv.invoice_number,
        _description := 'Invoice ' || v_inv.invoice_number || ' (integrity repair)',
        _source_type := 'invoice', _source_id := v_inv.id,
        _created_by := v_uid, _is_closing := false, _is_adjusting := false,
        _lines := v_lines, _currency := v_inv.currency,
        _exchange_rate := NULL, _source_subtype := NULL, _branch_id := v_inv.branch_id
      );

      UPDATE public.invoices SET journal_entry_id = v_je_id, updated_at = now() WHERE id = v_inv.id;

      INSERT INTO public.audit_logs (organization_id, business_id, user_id, action, entity_type, entity_id, entity_name, changes_summary)
      VALUES (_org_id, _business_id, v_uid, 'updated', 'invoice', v_inv.id, v_inv.invoice_number,
              'Integrity repair: posted missing AR journal entry ' || v_no);

      v_posted := v_posted + 1;
    EXCEPTION WHEN OTHERS THEN
      v_failed := v_failed + 1;
      v_errors := v_errors || jsonb_build_array(jsonb_build_object('invoice_number', v_inv.invoice_number, 'error', SQLERRM));
    END;
  END LOOP;

  RETURN jsonb_build_object('success', true, 'posted', v_posted, 'failed', v_failed, 'errors', v_errors);
END;
$fn$;

GRANT EXECUTE ON FUNCTION public.post_missing_invoice_journals(uuid, uuid, uuid, integer) TO authenticated;

-- ---------------------------------------------------------------
-- 5. Remove the ambiguous legacy overload
-- ---------------------------------------------------------------
DROP FUNCTION IF EXISTS public.get_control_account_reconciliation(uuid, uuid, text);
