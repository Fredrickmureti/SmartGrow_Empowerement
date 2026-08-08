-- ============================================================
-- Phase 1: open-items projections must recognise every settlement channel
-- ============================================================

CREATE OR REPLACE VIEW public.finance_ar_open_items AS
 WITH invoice_paid AS (
         SELECT pa.invoice_id,
            sum(pa.amount)::numeric(12,2) AS amount
           FROM payment_allocations pa
             JOIN payments p ON p.id = pa.payment_id
          WHERE p.status IS DISTINCT FROM 'voided'::text
          GROUP BY pa.invoice_id
        ), invoice_credited AS (
         SELECT cna.invoice_id,
            sum(cna.amount)::numeric(12,2) AS amount
           FROM credit_note_applications cna
             JOIN credit_notes cn ON cn.id = cna.credit_note_id
          WHERE cn.status::text <> ALL (ARRAY['draft'::text, 'cancelled'::text, 'voided'::text, 'void'::text])
          GROUP BY cna.invoice_id
        ), invoice_settled AS (
         SELECT inv.id AS invoice_id,
            (COALESCE(ip.amount, 0::numeric) + COALESCE(ic.amount, 0::numeric))::numeric(12,2) AS amount
           FROM invoices inv
             LEFT JOIN invoice_paid ip ON ip.invoice_id = inv.id
             LEFT JOIN invoice_credited ic ON ic.invoice_id = inv.id
        ), invoice_has_je AS (
         SELECT DISTINCT s.source_id AS invoice_id
           FROM ar_subledger_entries s
          WHERE s.source_type = 'invoice'::text AND s.source_id IS NOT NULL
        ), invoice_rows AS (
         SELECT inv.organization_id,
            inv.business_id,
            inv.branch_id,
            inv.id AS document_id,
            inv.invoice_number AS document_number,
            inv.contact_id,
            inv.issue_date AS document_date,
            inv.due_date,
            inv.total::numeric(12,2) AS document_total,
            COALESCE(isx.amount, 0::numeric)::numeric(12,2) AS applied_amount,
            GREATEST(inv.total - COALESCE(isx.amount, 0::numeric), 0::numeric)::numeric(12,2) AS residual_amount,
            inv.status::text AS document_status,
            inv.journal_entry_id
           FROM invoices inv
             JOIN invoice_has_je ihj ON ihj.invoice_id = inv.id
             LEFT JOIN invoice_settled isx ON isx.invoice_id = inv.id
          WHERE (inv.status::text <> ALL (ARRAY['draft'::text, 'cancelled'::text, 'voided'::text, 'paid'::text]))
            AND (inv.total - COALESCE(isx.amount, 0::numeric)) > 0.01
        ), manual_je_rows AS (
         SELECT s.organization_id,
            s.business_id,
            s.branch_id,
            s.journal_entry_id AS document_id,
            max(s.entry_number) AS document_number,
            s.contact_id,
            min(s.entry_date) AS document_date,
            min(s.entry_date) AS due_date,
            sum(s.debit - s.credit)::numeric(12,2) AS document_total,
            0::numeric(12,2) AS applied_amount,
            sum(s.debit - s.credit)::numeric(12,2) AS residual_amount,
            'journal'::text AS document_status,
            s.journal_entry_id
           FROM ar_subledger_entries s
          WHERE s.contact_id IS NOT NULL AND (s.source_type IS NULL OR (s.source_type <> ALL (ARRAY['invoice'::text, 'payment'::text, 'customer_payment'::text, 'credit_note'::text, 'customer_refund'::text, 'refund'::text])))
          GROUP BY s.organization_id, s.business_id, s.branch_id, s.journal_entry_id, s.contact_id
         HAVING sum(s.debit - s.credit) > 0.01
        )
 SELECT organization_id, business_id, branch_id, document_id, document_number,
        contact_id, document_date, due_date, document_total, applied_amount,
        residual_amount, document_status, journal_entry_id
   FROM invoice_rows
UNION ALL
 SELECT organization_id, business_id, branch_id, document_id, document_number,
        contact_id, document_date, due_date, document_total, applied_amount,
        residual_amount, document_status, journal_entry_id
   FROM manual_je_rows;

CREATE OR REPLACE VIEW public.finance_ap_open_items AS
 WITH bill_paid AS (
         SELECT bpa.bill_id,
            sum(bpa.amount)::numeric(12,2) AS amount
           FROM bill_payment_allocations bpa
          GROUP BY bpa.bill_id
        ), bill_credited AS (
         SELECT vca.bill_id,
            sum(vca.amount)::numeric(12,2) AS amount
           FROM vendor_credit_note_applications vca
             JOIN vendor_credit_notes vcn ON vcn.id = vca.credit_note_id
          WHERE vcn.status::text <> ALL (ARRAY['draft'::text, 'cancelled'::text, 'voided'::text, 'void'::text])
          GROUP BY vca.bill_id
        ), bill_settled AS (
         SELECT b.id AS bill_id,
            (COALESCE(bp.amount, 0::numeric) + COALESCE(bc.amount, 0::numeric))::numeric(12,2) AS amount
           FROM bills b
             LEFT JOIN bill_paid bp ON bp.bill_id = b.id
             LEFT JOIN bill_credited bc ON bc.bill_id = b.id
        ), bill_has_je AS (
         SELECT DISTINCT s.source_id AS bill_id
           FROM ap_subledger_entries s
          WHERE s.source_type = 'bill'::text AND s.source_id IS NOT NULL
        ), bill_rows AS (
         SELECT b.organization_id,
            b.business_id,
            b.branch_id,
            b.id AS document_id,
            b.bill_number AS document_number,
            b.vendor_id AS contact_id,
            b.bill_date AS document_date,
            b.due_date,
            b.total AS document_total,
            COALESCE(bs.amount, 0::numeric)::numeric(12,2) AS applied_amount,
            GREATEST(b.total - COALESCE(bs.amount, 0::numeric), 0::numeric)::numeric(12,2) AS residual_amount,
            b.status::text AS document_status,
            ( SELECT je.id
                   FROM journal_entries je
                  WHERE je.source_type = 'bill'::text AND je.source_id = b.id AND je.status = 'posted'::text
                  ORDER BY je.entry_date, je.created_at
                 LIMIT 1) AS journal_entry_id
           FROM bills b
             JOIN bill_has_je bhj ON bhj.bill_id = b.id
             LEFT JOIN bill_settled bs ON bs.bill_id = b.id
          WHERE (b.status::text <> ALL (ARRAY['draft'::text, 'void'::text, 'voided'::text, 'cancelled'::text, 'paid'::text]))
            AND (b.total - COALESCE(bs.amount, 0::numeric)) > 0.01
        ), manual_je_rows AS (
         SELECT s.organization_id,
            s.business_id,
            s.branch_id,
            s.journal_entry_id AS document_id,
            max(s.entry_number) AS document_number,
            s.contact_id,
            min(s.entry_date) AS document_date,
            min(s.entry_date) AS due_date,
            sum(s.credit - s.debit)::numeric(12,2) AS document_total,
            0::numeric(12,2) AS applied_amount,
            sum(s.credit - s.debit)::numeric(12,2) AS residual_amount,
            'journal'::text AS document_status,
            s.journal_entry_id
           FROM ap_subledger_entries s
          WHERE s.contact_id IS NOT NULL AND (s.source_type IS NULL OR (s.source_type <> ALL (ARRAY['bill'::text, 'bill_payment'::text, 'vendor_credit_note'::text, 'vendor_refund'::text])))
          GROUP BY s.organization_id, s.business_id, s.branch_id, s.journal_entry_id, s.contact_id
         HAVING sum(s.credit - s.debit) > 0.01
        )
 SELECT organization_id, business_id, branch_id, document_id, document_number,
        contact_id, document_date, due_date, document_total, applied_amount,
        residual_amount, document_status, journal_entry_id
   FROM bill_rows
UNION ALL
 SELECT organization_id, business_id, branch_id, document_id, document_number,
        contact_id, document_date, due_date, document_total, applied_amount,
        residual_amount, document_status, journal_entry_id
   FROM manual_je_rows;

-- Drift detector: projection residual vs subledger net, per business and side.
CREATE OR REPLACE VIEW public.finance_open_items_tieout AS
 WITH ar_proj AS (
    SELECT organization_id, business_id, sum(residual_amount)::numeric(14,2) AS projection_residual
      FROM public.finance_ar_open_items GROUP BY 1,2
 ), ar_ledger AS (
    SELECT organization_id, business_id, sum(debit - credit)::numeric(14,2) AS ledger_net
      FROM ar_subledger_entries GROUP BY 1,2
 ), ap_proj AS (
    SELECT organization_id, business_id, sum(residual_amount)::numeric(14,2) AS projection_residual
      FROM public.finance_ap_open_items GROUP BY 1,2
 ), ap_ledger AS (
    SELECT organization_id, business_id, sum(credit - debit)::numeric(14,2) AS ledger_net
      FROM ap_subledger_entries GROUP BY 1,2
 )
 SELECT 'ar'::text AS side,
        COALESCE(p.organization_id, l.organization_id) AS organization_id,
        COALESCE(p.business_id, l.business_id) AS business_id,
        COALESCE(p.projection_residual, 0)::numeric(14,2) AS projection_residual,
        COALESCE(l.ledger_net, 0)::numeric(14,2) AS ledger_net,
        (COALESCE(p.projection_residual, 0) - COALESCE(l.ledger_net, 0))::numeric(14,2) AS drift
   FROM ar_proj p FULL JOIN ar_ledger l
     ON l.organization_id = p.organization_id AND l.business_id IS NOT DISTINCT FROM p.business_id
 UNION ALL
 SELECT 'ap'::text,
        COALESCE(p.organization_id, l.organization_id),
        COALESCE(p.business_id, l.business_id),
        COALESCE(p.projection_residual, 0)::numeric(14,2),
        COALESCE(l.ledger_net, 0)::numeric(14,2),
        (COALESCE(p.projection_residual, 0) - COALESCE(l.ledger_net, 0))::numeric(14,2)
   FROM ap_proj p FULL JOIN ap_ledger l
     ON l.organization_id = p.organization_id AND l.business_id IS NOT DISTINCT FROM p.business_id;

GRANT SELECT ON public.finance_open_items_tieout TO authenticated;
GRANT SELECT ON public.finance_open_items_tieout TO service_role;

-- ============================================================
-- Phase 2: one post-confirmation invoice status ('sent')
-- ============================================================

CREATE OR REPLACE FUNCTION public.generate_recurring_invoice_occurrence(_recurring_id uuid, _period_start date, _user_id uuid DEFAULT NULL::uuid, _trigger_source text DEFAULT 'schedule'::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_ri record;
  v_run record;
  v_period_end date;
  v_next_start date;
  v_run_id uuid;
  v_invoice_id uuid;
  v_invoice_number text;
  v_due_date date;
  v_subtotal numeric := 0;
  v_tax numeric := 0;
  v_accounts jsonb;
  v_ar uuid;
  v_rev_default uuid;
  v_tax_account uuid;
  v_lines jsonb;
  v_je_id uuid;
  v_entry_no text;
  v_status text;
  v_delivery text;
BEGIN
  SELECT * INTO v_ri FROM public.recurring_invoices WHERE id = _recurring_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Recurring template % not found', _recurring_id;
  END IF;

  v_next_start := public.recurring_next_start(
    v_ri.frequency, _period_start,
    EXTRACT(day FROM COALESCE(v_ri.start_date, _period_start))::int);
  v_period_end := v_next_start - 1;

  SELECT * INTO v_run FROM public.recurring_invoice_runs
   WHERE recurring_invoice_id = _recurring_id AND period_start = _period_start
   FOR UPDATE;

  IF FOUND THEN
    IF v_run.status IN ('generated','posted','skipped') THEN
      RETURN jsonb_build_object(
        'status', v_run.status, 'duplicate', true, 'run_id', v_run.id,
        'invoice_id', v_run.invoice_id, 'invoice_number', v_run.invoice_number,
        'period_start', _period_start, 'period_end', v_run.period_end,
        'next_run_date', v_next_start);
    END IF;
    UPDATE public.recurring_invoice_runs
       SET status = 'claimed', attempt_count = attempt_count + 1,
           failure_reason = NULL, triggered_by = _user_id,
           trigger_source = _trigger_source
     WHERE id = v_run.id
    RETURNING id INTO v_run_id;
  ELSE
    INSERT INTO public.recurring_invoice_runs (
      recurring_invoice_id, organization_id, business_id, branch_id,
      period_start, period_end, status, triggered_by, trigger_source)
    VALUES (_recurring_id, v_ri.organization_id, v_ri.business_id, v_ri.branch_id,
            _period_start, v_period_end, 'claimed', _user_id, _trigger_source)
    RETURNING id INTO v_run_id;
  END IF;

  BEGIN
    IF v_ri.contact_id IS NULL THEN
      RAISE EXCEPTION 'Recurring template has no customer';
    END IF;
    IF v_ri.business_id IS NULL THEN
      RAISE EXCEPTION 'Recurring template has no business scope';
    END IF;
    IF v_ri.end_date IS NOT NULL AND _period_start > v_ri.end_date THEN
      RAISE EXCEPTION 'Billing period % is past the schedule end date %', _period_start, v_ri.end_date;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.recurring_invoice_items WHERE recurring_invoice_id = _recurring_id) THEN
      RAISE EXCEPTION 'Recurring template has no line items';
    END IF;

    SELECT
      COALESCE(ROUND(SUM(quantity * unit_price * (1 - COALESCE(discount_percent,0)/100.0)), 2), 0),
      COALESCE(ROUND(SUM(quantity * unit_price * (1 - COALESCE(discount_percent,0)/100.0) * COALESCE(tax_rate,0)/100.0), 2), 0)
      INTO v_subtotal, v_tax
      FROM public.recurring_invoice_items WHERE recurring_invoice_id = _recurring_id;

    v_invoice_number := public.get_next_invoice_number(v_ri.organization_id, v_ri.business_id);
    v_due_date := _period_start + COALESCE(v_ri.days_before_due, 30);

    INSERT INTO public.invoices (
      organization_id, business_id, branch_id, contact_id, invoice_number,
      status, issue_date, due_date, billing_period_start, billing_period_end,
      subtotal, tax_amount, total, currency, notes, terms,
      created_by, source, source_recurring_id)
    VALUES (
      v_ri.organization_id, v_ri.business_id, v_ri.branch_id, v_ri.contact_id, v_invoice_number,
      'draft', _period_start, v_due_date, _period_start, v_period_end,
      v_subtotal, v_tax, v_subtotal + v_tax, v_ri.currency, v_ri.notes, v_ri.terms,
      COALESCE(_user_id, v_ri.created_by), 'recurring', _recurring_id)
    RETURNING id INTO v_invoice_id;

    INSERT INTO public.invoice_items (
      invoice_id, business_id, product_id, description, quantity, unit_price,
      tax_rate, tax_amount, discount_percent, line_total, sort_order)
    SELECT
      v_invoice_id, v_ri.business_id, i.product_id, i.description, i.quantity, i.unit_price,
      COALESCE(i.tax_rate,0),
      ROUND(i.quantity * i.unit_price * (1 - COALESCE(i.discount_percent,0)/100.0) * COALESCE(i.tax_rate,0)/100.0, 2),
      COALESCE(i.discount_percent,0),
      ROUND(i.quantity * i.unit_price * (1 - COALESCE(i.discount_percent,0)/100.0), 2),
      i.sort_order
    FROM public.recurring_invoice_items i
    WHERE i.recurring_invoice_id = _recurring_id;

    v_status := 'generated';

    IF COALESCE(v_ri.auto_confirm, false) THEN
      v_accounts := public._resolve_invoice_gl_accounts(
        v_ri.organization_id, v_ri.business_id, v_ri.contact_id,
        ARRAY(SELECT product_id FROM public.recurring_invoice_items
               WHERE recurring_invoice_id = _recurring_id AND product_id IS NOT NULL));

      v_ar := NULLIF(v_accounts->>'ar_account_id','')::uuid;
      v_rev_default := NULLIF(v_accounts->>'revenue_default_account_id','')::uuid;
      v_tax_account := public.get_default_account_id(v_ri.organization_id, v_ri.business_id, 'output_tax');

      IF v_ar IS NULL OR v_rev_default IS NULL THEN
        RAISE EXCEPTION 'Auto-posting requires Accounts Receivable and Sales Revenue default accounts';
      END IF;
      IF v_tax > 0 AND v_tax_account IS NULL THEN
        RAISE EXCEPTION 'Auto-posting a taxed invoice requires an Output Tax default account';
      END IF;

      SELECT jsonb_agg(l ORDER BY ord) INTO v_lines FROM (
        SELECT 0 AS ord, jsonb_build_object(
          'account_id', v_ar, 'debit', v_subtotal + v_tax, 'credit', 0,
          'description', 'Invoice ' || v_invoice_number || ' - Accounts Receivable',
          'contact_id', v_ri.contact_id) AS l
        UNION ALL
        SELECT 1, jsonb_build_object(
          'account_id', acct, 'debit', 0, 'credit', amt,
          'description', 'Invoice ' || v_invoice_number || ' - Sales Revenue')
        FROM (
          SELECT COALESCE(p.sales_account_id, v_rev_default) AS acct,
                 ROUND(SUM(i.quantity * i.unit_price * (1 - COALESCE(i.discount_percent,0)/100.0)), 2) AS amt
            FROM public.recurring_invoice_items i
            LEFT JOIN public.products p ON p.id = i.product_id
           WHERE i.recurring_invoice_id = _recurring_id
           GROUP BY COALESCE(p.sales_account_id, v_rev_default)
        ) rev
        UNION ALL
        SELECT 2, jsonb_build_object(
          'account_id', v_tax_account, 'debit', 0, 'credit', v_tax,
          'description', 'Invoice ' || v_invoice_number || ' - Tax Liability')
        WHERE v_tax > 0 AND v_tax_account IS NOT NULL
      ) lines;

      v_entry_no := public.get_next_journal_entry_number(v_ri.organization_id);
      v_je_id := public.post_journal_entry_atomic(
        _org_id := v_ri.organization_id, _business_id := v_ri.business_id,
        _entry_number := v_entry_no, _entry_date := _period_start,
        _reference := v_invoice_number,
        _description := 'Invoice ' || v_invoice_number,
        _source_type := 'invoice', _source_id := v_invoice_id,
        _created_by := _user_id, _is_closing := false, _is_adjusting := false,
        _lines := v_lines, _currency := v_ri.currency,
        _exchange_rate := NULL, _source_subtype := NULL, _branch_id := v_ri.branch_id);

      -- 'sent' is the single canonical post-confirmation open status, matching
      -- a manual confirmation, so the invoice is payable everywhere.
      UPDATE public.invoices
         SET status = 'sent', journal_entry_id = v_je_id, confirmed_by = _user_id
       WHERE id = v_invoice_id;

      v_status := 'posted';
    END IF;

    UPDATE public.recurring_invoices
       SET last_run_date = _period_start,
           next_run_date = v_next_start,
           invoices_generated = COALESCE(invoices_generated, 0) + 1,
           is_active = CASE WHEN end_date IS NOT NULL AND v_next_start > end_date THEN false ELSE is_active END,
           completed_at = CASE WHEN end_date IS NOT NULL AND v_next_start > end_date THEN now() ELSE completed_at END,
           updated_at = now()
     WHERE id = _recurring_id;

    UPDATE public.recurring_invoice_runs
       SET period_end = v_period_end
     WHERE id = v_run_id;

    v_delivery := CASE
      WHEN COALESCE(v_ri.auto_send, false) AND v_status = 'posted' THEN 'pending'
      ELSE 'not_applicable' END;

    UPDATE public.recurring_invoice_runs
       SET status = v_status, invoice_id = v_invoice_id, invoice_number = v_invoice_number,
           journal_entry_id = v_je_id, failure_reason = NULL, delivery_status = v_delivery
     WHERE id = v_run_id;

    RETURN jsonb_build_object(
      'status', v_status, 'duplicate', false, 'run_id', v_run_id,
      'invoice_id', v_invoice_id, 'invoice_number', v_invoice_number,
      'journal_entry_id', v_je_id, 'period_start', _period_start,
      'period_end', v_period_end, 'next_run_date', v_next_start);

  EXCEPTION WHEN OTHERS THEN
    DECLARE v_msg text := SQLERRM;
    BEGIN
      UPDATE public.recurring_invoice_runs
         SET status = 'failed', failure_reason = v_msg, invoice_id = NULL,
             invoice_number = NULL, journal_entry_id = NULL
       WHERE id = v_run_id;
      RETURN jsonb_build_object(
        'status', 'failed', 'duplicate', false, 'run_id', v_run_id,
        'error', v_msg, 'period_start', _period_start, 'period_end', v_period_end);
    END;
  END;
END;
$function$;

-- Backfill: already-posted invoices stuck on the non-canonical 'confirmed'
-- status become payable without manual intervention.
UPDATE public.invoices
   SET status = 'sent'
 WHERE status::text = 'confirmed'
   AND journal_entry_id IS NOT NULL;
