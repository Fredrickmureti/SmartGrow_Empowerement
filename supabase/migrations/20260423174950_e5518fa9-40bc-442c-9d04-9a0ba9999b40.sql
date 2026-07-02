
-- =====================================================================
-- 1) convert_estimate_to_so_atomic
-- =====================================================================
CREATE OR REPLACE FUNCTION public.convert_estimate_to_so_atomic(
  p_estimate_id uuid,
  p_user_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_est RECORD;
  v_so_number text;
  v_so_id uuid;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'auth required' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_est
  FROM public.estimates
  WHERE id = p_estimate_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Estimate % not found', p_estimate_id;
  END IF;

  IF v_est.status = 'converted' THEN
    RAISE EXCEPTION 'Estimate % already converted', v_est.estimate_number;
  END IF;
  IF v_est.status NOT IN ('draft','sent','viewed','accepted','approved') THEN
    RAISE EXCEPTION 'Cannot convert estimate in status %', v_est.status;
  END IF;

  IF v_est.business_id IS NULL OR NOT public.user_can_access_business(p_user_id, v_est.business_id) THEN
    RAISE EXCEPTION 'Access denied for business %', v_est.business_id USING ERRCODE = '42501';
  END IF;

  SELECT public.get_next_so_number(v_est.organization_id) INTO v_so_number;

  INSERT INTO public.sales_orders(
    organization_id, business_id, branch_id, contact_id,
    so_number, status, order_date, expected_date,
    subtotal, tax_amount, discount_amount, total, currency,
    notes, created_by, source_estimate_id
  ) VALUES (
    v_est.organization_id, v_est.business_id, v_est.branch_id, v_est.contact_id,
    v_so_number, 'draft', CURRENT_DATE, CURRENT_DATE + INTERVAL '14 days',
    v_est.subtotal, v_est.tax_amount, COALESCE(v_est.discount_amount,0), v_est.total, v_est.currency,
    v_est.notes, p_user_id, p_estimate_id
  )
  RETURNING id INTO v_so_id;

  INSERT INTO public.sales_order_items(
    sales_order_id, product_id, description, quantity, unit_price,
    tax_rate, tax_amount, discount_percent, line_total, sort_order
  )
  SELECT
    v_so_id, ei.product_id, ei.description, ei.quantity, ei.unit_price,
    COALESCE(ei.tax_rate,0), COALESCE(ei.tax_amount,0),
    COALESCE(ei.discount_percent,0), ei.line_total, ei.sort_order
  FROM public.estimate_items ei
  WHERE ei.estimate_id = p_estimate_id;

  UPDATE public.estimates
  SET status = 'converted',
      updated_at = now()
  WHERE id = p_estimate_id;

  RETURN jsonb_build_object(
    'success', true,
    'sales_order_id', v_so_id,
    'so_number', v_so_number
  );
END;
$function$;

GRANT EXECUTE ON FUNCTION public.convert_estimate_to_so_atomic(uuid, uuid) TO authenticated;

-- =====================================================================
-- 2) confirm_invoice_atomic
--    Client passes pre-resolved JE entries (revenue + tax + AR + optional
--    COGS) — server validates draft, posts JE(s) via post_journal_entry_atomic,
--    flips status to confirmed and links journal_entry_id, all in one tx.
-- =====================================================================
CREATE OR REPLACE FUNCTION public.confirm_invoice_atomic(
  p_invoice_id uuid,
  p_user_id uuid,
  p_main_lines jsonb,
  p_cogs_lines jsonb DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_inv RECORD;
  v_je_id uuid;
  v_cogs_je_id uuid;
  v_main_entry_no text;
  v_cogs_entry_no text;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'auth required' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_inv
  FROM public.invoices
  WHERE id = p_invoice_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Invoice % not found', p_invoice_id;
  END IF;

  IF v_inv.status <> 'draft' THEN
    RAISE EXCEPTION 'Only draft invoices can be confirmed (current: %)', v_inv.status;
  END IF;

  IF v_inv.business_id IS NULL OR NOT public.user_can_access_business(p_user_id, v_inv.business_id) THEN
    RAISE EXCEPTION 'Access denied for business %', v_inv.business_id USING ERRCODE = '42501';
  END IF;

  IF p_main_lines IS NULL OR jsonb_array_length(p_main_lines) < 2 THEN
    RAISE EXCEPTION 'Invoice JE requires at least 2 lines';
  END IF;

  -- Generate entry numbers
  SELECT public.get_next_journal_entry_number(v_inv.organization_id) INTO v_main_entry_no;

  -- Post main revenue JE (idempotent on (org, source_type, source_id, subtype))
  v_je_id := public.post_journal_entry_atomic(
    _org_id          := v_inv.organization_id,
    _business_id     := v_inv.business_id,
    _entry_number    := v_main_entry_no,
    _entry_date      := v_inv.issue_date,
    _reference       := v_inv.invoice_number,
    _description     := 'Invoice ' || v_inv.invoice_number || ' confirmed',
    _source_type     := 'invoice',
    _source_id       := p_invoice_id,
    _created_by      := p_user_id,
    _is_closing      := false,
    _is_adjusting    := false,
    _lines           := p_main_lines,
    _currency        := v_inv.currency,
    _exchange_rate   := NULL,
    _source_subtype  := NULL,
    _branch_id       := v_inv.branch_id
  );

  -- Optional COGS JE
  IF p_cogs_lines IS NOT NULL AND jsonb_array_length(p_cogs_lines) >= 2 THEN
    SELECT public.get_next_journal_entry_number(v_inv.organization_id) INTO v_cogs_entry_no;
    v_cogs_je_id := public.post_journal_entry_atomic(
      _org_id          := v_inv.organization_id,
      _business_id     := v_inv.business_id,
      _entry_number    := v_cogs_entry_no,
      _entry_date      := v_inv.issue_date,
      _reference       := 'COGS-' || v_inv.invoice_number,
      _description     := 'COGS for Invoice ' || v_inv.invoice_number,
      _source_type     := 'invoice',
      _source_id       := p_invoice_id,
      _created_by      := p_user_id,
      _is_closing      := false,
      _is_adjusting    := false,
      _lines           := p_cogs_lines,
      _currency        := v_inv.currency,
      _exchange_rate   := NULL,
      _source_subtype  := 'cogs',
      _branch_id       := v_inv.branch_id
    );
  END IF;

  -- Flip status + link JE in same tx
  UPDATE public.invoices
  SET status = 'confirmed',
      confirmed_by = p_user_id,
      journal_entry_id = v_je_id,
      updated_at = now()
  WHERE id = p_invoice_id;

  RETURN jsonb_build_object(
    'success', true,
    'journal_entry_id', v_je_id,
    'cogs_journal_entry_id', v_cogs_je_id
  );
END;
$function$;

GRANT EXECUTE ON FUNCTION public.confirm_invoice_atomic(uuid, uuid, jsonb, jsonb) TO authenticated;

-- =====================================================================
-- 3) Tighten dashboard branch filter — strict equality when branch given.
--    Convention:
--      p_branch_id IS NULL  → company-wide (no branch filter)
--      p_branch_id = X      → strict branch_id = X (no NULL widening)
-- =====================================================================
CREATE OR REPLACE FUNCTION public.get_sales_dashboard_kpis(
  p_org_id uuid,
  p_business_id uuid,
  p_date_from date,
  p_date_to date,
  p_branch_id uuid DEFAULT NULL::uuid
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_user_id uuid := auth.uid();
  v_today   date := CURRENT_DATE;
  v_from    date := COALESCE(p_date_from, '1900-01-01'::date);
  v_to      date := COALESCE(p_date_to, v_today);

  v_draft_n   bigint := 0;
  v_sent_n    bigint := 0;
  v_overdue_n bigint := 0;
  v_paid_n    bigint := 0;
  v_period_paid_n bigint := 0;
  v_recv_total       numeric := 0;
  v_recv_overdue_amt numeric := 0;
  v_recv_overdue_n   bigint  := 0;
  v_age_curr  numeric := 0;
  v_age_30    numeric := 0;
  v_age_60    numeric := 0;
  v_age_90    numeric := 0;
  v_age_90p   numeric := 0;
  v_est_total    bigint := 0;
  v_est_accepted bigint := 0;
  v_est_open     bigint := 0;
  v_so_pending bigint := 0;
  v_cn_count bigint  := 0;
  v_cn_total numeric := 0;
  v_pay_count bigint  := 0;
  v_pay_total numeric := 0;
  v_top_customers   jsonb := '[]'::jsonb;
  v_recent_payments jsonb := '[]'::jsonb;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'auth required' USING ERRCODE = '42501';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.organization_members
    WHERE organization_id = p_org_id AND user_id = v_user_id
  ) THEN
    RAISE EXCEPTION 'forbidden: not a member of this organization' USING ERRCODE = '42501';
  END IF;

  -- Pipeline: STRICT branch equality when p_branch_id is given
  SELECT
    COUNT(*) FILTER (WHERE status = 'draft'),
    COUNT(*) FILTER (WHERE status IN ('sent','viewed','partial','confirmed')),
    COUNT(*) FILTER (WHERE status = 'overdue'
                      OR (status IN ('sent','viewed','partial','confirmed')
                          AND due_date IS NOT NULL AND due_date < v_today
                          AND (total - COALESCE(amount_paid,0)) > 0)),
    COUNT(*) FILTER (WHERE status = 'paid')
  INTO v_draft_n, v_sent_n, v_overdue_n, v_paid_n
  FROM public.invoices
  WHERE organization_id = p_org_id
    AND (p_business_id IS NULL OR business_id = p_business_id)
    AND (p_branch_id IS NULL OR branch_id = p_branch_id)
    AND status <> 'cancelled' AND status <> 'voided';

  SELECT COUNT(*)
  INTO v_period_paid_n
  FROM public.invoices
  WHERE organization_id = p_org_id
    AND (p_business_id IS NULL OR business_id = p_business_id)
    AND (p_branch_id IS NULL OR branch_id = p_branch_id)
    AND status = 'paid'
    AND issue_date BETWEEN v_from AND v_to;

  SELECT
    COALESCE(SUM(GREATEST(total - COALESCE(amount_paid,0), 0)), 0),
    COALESCE(SUM(CASE WHEN due_date IS NOT NULL AND due_date < v_today
                      THEN GREATEST(total - COALESCE(amount_paid,0), 0)
                      ELSE 0 END), 0),
    COUNT(*) FILTER (WHERE due_date IS NOT NULL AND due_date < v_today
                       AND (total - COALESCE(amount_paid,0)) > 0)
  INTO v_recv_total, v_recv_overdue_amt, v_recv_overdue_n
  FROM public.invoices
  WHERE organization_id = p_org_id
    AND (p_business_id IS NULL OR business_id = p_business_id)
    AND (p_branch_id IS NULL OR branch_id = p_branch_id)
    AND status NOT IN ('paid','cancelled','voided','draft');

  WITH open_inv AS (
    SELECT due_date, GREATEST(total - COALESCE(amount_paid,0), 0) AS bal
    FROM public.invoices
    WHERE organization_id = p_org_id
      AND (p_business_id IS NULL OR business_id = p_business_id)
      AND (p_branch_id IS NULL OR branch_id = p_branch_id)
      AND status NOT IN ('paid','cancelled','voided','draft')
      AND (total - COALESCE(amount_paid,0)) > 0
  )
  SELECT
    COALESCE(SUM(bal) FILTER (WHERE due_date IS NULL OR due_date >= v_today), 0),
    COALESCE(SUM(bal) FILTER (WHERE due_date <  v_today AND due_date >= v_today - 30), 0),
    COALESCE(SUM(bal) FILTER (WHERE due_date <  v_today - 30 AND due_date >= v_today - 60), 0),
    COALESCE(SUM(bal) FILTER (WHERE due_date <  v_today - 60 AND due_date >= v_today - 90), 0),
    COALESCE(SUM(bal) FILTER (WHERE due_date <  v_today - 90), 0)
  INTO v_age_curr, v_age_30, v_age_60, v_age_90, v_age_90p
  FROM open_inv;

  SELECT
    COUNT(*),
    COUNT(*) FILTER (WHERE status = 'accepted'),
    COUNT(*) FILTER (WHERE status IN ('sent','viewed'))
  INTO v_est_total, v_est_accepted, v_est_open
  FROM public.estimates
  WHERE organization_id = p_org_id
    AND (p_business_id IS NULL OR business_id = p_business_id)
    AND (p_branch_id IS NULL OR branch_id = p_branch_id);

  SELECT COUNT(*)
  INTO v_so_pending
  FROM public.sales_orders
  WHERE organization_id = p_org_id
    AND (p_business_id IS NULL OR business_id = p_business_id)
    AND (p_branch_id IS NULL OR branch_id = p_branch_id)
    AND status NOT IN ('delivered','cancelled','invoiced','closed','completed');

  SELECT COUNT(*), COALESCE(SUM(total), 0)
  INTO v_cn_count, v_cn_total
  FROM public.credit_notes
  WHERE organization_id = p_org_id
    AND (p_business_id IS NULL OR business_id = p_business_id)
    AND (p_branch_id IS NULL OR branch_id = p_branch_id)
    AND status NOT IN ('cancelled','voided','draft')
    AND issue_date BETWEEN v_from AND v_to;

  SELECT COUNT(*), COALESCE(SUM(amount), 0)
  INTO v_pay_count, v_pay_total
  FROM public.payments
  WHERE organization_id = p_org_id
    AND (p_business_id IS NULL OR business_id = p_business_id)
    AND (p_branch_id IS NULL OR branch_id = p_branch_id)
    AND payment_date BETWEEN v_from AND v_to;

  SELECT COALESCE(jsonb_agg(t ORDER BY t.total_revenue DESC), '[]'::jsonb)
  INTO v_top_customers
  FROM (
    SELECT i.contact_id,
           COALESCE(c.name, 'Unknown') AS name,
           COUNT(*)::bigint AS invoice_count,
           COALESCE(SUM(i.total), 0)::numeric AS total_revenue
    FROM public.invoices i
    LEFT JOIN public.contacts c ON c.id = i.contact_id
    WHERE i.organization_id = p_org_id
      AND (p_business_id IS NULL OR i.business_id = p_business_id)
      AND (p_branch_id IS NULL OR i.branch_id = p_branch_id)
      AND i.status NOT IN ('cancelled','voided','draft')
      AND i.issue_date BETWEEN v_from AND v_to
      AND i.contact_id IS NOT NULL
    GROUP BY i.contact_id, c.name
    ORDER BY total_revenue DESC
    LIMIT 5
  ) t;

  SELECT COALESCE(jsonb_agg(t ORDER BY t.payment_date DESC), '[]'::jsonb)
  INTO v_recent_payments
  FROM (
    SELECT p.id, p.amount, p.payment_date, p.contact_id,
           c.name AS contact_name
    FROM public.payments p
    LEFT JOIN public.contacts c ON c.id = p.contact_id
    WHERE p.organization_id = p_org_id
      AND (p_business_id IS NULL OR p.business_id = p_business_id)
      AND (p_branch_id IS NULL OR p.branch_id = p_branch_id)
      AND p.payment_date BETWEEN v_from AND v_to
    ORDER BY p.payment_date DESC, p.created_at DESC
    LIMIT 5
  ) t;

  RETURN jsonb_build_object(
    'pipeline', jsonb_build_object('draft', v_draft_n, 'sent', v_sent_n, 'overdue', v_overdue_n, 'paid', v_paid_n),
    'period_paid_count', v_period_paid_n,
    'receivable', jsonb_build_object('total', v_recv_total, 'overdue_amount', v_recv_overdue_amt, 'overdue_count', v_recv_overdue_n),
    'aging', jsonb_build_object('current', v_age_curr, 'days_1_30', v_age_30, 'days_31_60', v_age_60, 'days_61_90', v_age_90, 'days_90_plus', v_age_90p),
    'estimates', jsonb_build_object('total', v_est_total, 'accepted', v_est_accepted, 'open', v_est_open),
    'sales_orders_pending', v_so_pending,
    'credit_notes', jsonb_build_object('count', v_cn_count, 'total', v_cn_total),
    'payments', jsonb_build_object('count', v_pay_count, 'total', v_pay_total),
    'top_customers',   v_top_customers,
    'recent_payments', v_recent_payments
  );
END;
$function$;
