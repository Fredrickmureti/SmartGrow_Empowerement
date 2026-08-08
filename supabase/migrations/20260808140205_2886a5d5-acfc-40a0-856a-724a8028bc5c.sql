-- ─── Phase 1: occurrence ledger ────────────────────────────────────────────

ALTER TABLE public.invoices
  ADD COLUMN IF NOT EXISTS billing_period_start date,
  ADD COLUMN IF NOT EXISTS billing_period_end date;

ALTER TABLE public.recurring_invoices
  ADD COLUMN IF NOT EXISTS completed_at timestamptz;

CREATE TABLE IF NOT EXISTS public.recurring_invoice_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  recurring_invoice_id uuid NOT NULL REFERENCES public.recurring_invoices(id) ON DELETE CASCADE,
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  business_id uuid,
  branch_id uuid,
  period_start date NOT NULL,
  period_end date NOT NULL,
  status text NOT NULL DEFAULT 'claimed'
    CHECK (status IN ('claimed','generated','posted','failed','skipped')),
  invoice_id uuid REFERENCES public.invoices(id) ON DELETE SET NULL,
  invoice_number text,
  journal_entry_id uuid,
  failure_reason text,
  delivery_status text NOT NULL DEFAULT 'pending'
    CHECK (delivery_status IN ('pending','not_applicable','queued','sent','failed')),
  delivery_error text,
  delivered_at timestamptz,
  attempt_count integer NOT NULL DEFAULT 1,
  triggered_by uuid,
  trigger_source text NOT NULL DEFAULT 'schedule'
    CHECK (trigger_source IN ('schedule','manual','api')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS recurring_invoice_runs_period_key
  ON public.recurring_invoice_runs (recurring_invoice_id, period_start);
CREATE INDEX IF NOT EXISTS idx_rir_org_created
  ON public.recurring_invoice_runs (organization_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_rir_delivery_retry
  ON public.recurring_invoice_runs (delivery_status)
  WHERE delivery_status IN ('pending','failed');

GRANT SELECT ON public.recurring_invoice_runs TO authenticated;
GRANT ALL ON public.recurring_invoice_runs TO service_role;

ALTER TABLE public.recurring_invoice_runs ENABLE ROW LEVEL SECURITY;

CREATE POLICY recurring_invoice_runs_select
  ON public.recurring_invoice_runs FOR SELECT TO authenticated
  USING (public.user_has_module_permission(auth.uid(), organization_id, 'sales', 'read'));

CREATE TRIGGER set_recurring_invoice_runs_updated_at
  BEFORE UPDATE ON public.recurring_invoice_runs
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- ─── Phase 2: the single generation engine ────────────────────────────────

CREATE OR REPLACE FUNCTION public.recurring_period_end(_frequency text, _period_start date)
RETURNS date
LANGUAGE sql IMMUTABLE
SET search_path = public
AS $$
  SELECT (_period_start + CASE _frequency
    WHEN 'weekly'    THEN interval '7 days'
    WHEN 'biweekly'  THEN interval '14 days'
    WHEN 'monthly'   THEN interval '1 month'
    WHEN 'quarterly' THEN interval '3 months'
    WHEN 'yearly'    THEN interval '1 year'
    ELSE interval '1 month' END)::date - 1;
$$;

CREATE OR REPLACE FUNCTION public.generate_recurring_invoice_occurrence(
  _recurring_id uuid,
  _period_start date,
  _user_id uuid DEFAULT NULL,
  _trigger_source text DEFAULT 'schedule'
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
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

  v_period_end := public.recurring_period_end(v_ri.frequency, _period_start);
  v_next_start := v_period_end + 1;

  -- Claim the occurrence. A second caller for the same period either sees a
  -- completed run (idempotent return) or retries a previously failed one.
  SELECT * INTO v_run FROM public.recurring_invoice_runs
   WHERE recurring_invoice_id = _recurring_id AND period_start = _period_start
   FOR UPDATE;

  IF FOUND THEN
    IF v_run.status IN ('generated','posted','skipped') THEN
      RETURN jsonb_build_object(
        'status', v_run.status, 'duplicate', true, 'run_id', v_run.id,
        'invoice_id', v_run.invoice_id, 'invoice_number', v_run.invoice_number,
        'period_start', _period_start, 'period_end', v_run.period_end);
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

      UPDATE public.invoices
         SET status = 'confirmed', journal_entry_id = v_je_id, confirmed_by = _user_id
       WHERE id = v_invoice_id;

      v_status := 'posted';
    END IF;

    -- Schedule advancement: only after a committed, successful occurrence.
    UPDATE public.recurring_invoices
       SET last_run_date = _period_start,
           next_run_date = v_next_start,
           invoices_generated = COALESCE(invoices_generated, 0) + 1,
           is_active = CASE WHEN end_date IS NOT NULL AND v_next_start > end_date THEN false ELSE is_active END,
           completed_at = CASE WHEN end_date IS NOT NULL AND v_next_start > end_date THEN now() ELSE completed_at END,
           updated_at = now()
     WHERE id = _recurring_id;

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
    -- The whole occurrence rolls back: no invoice, no schedule advance.
    -- The failure is recorded in its own statement so the period is retried.
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
$$;

REVOKE ALL ON FUNCTION public.generate_recurring_invoice_occurrence(uuid, date, uuid, text) FROM public;
GRANT EXECUTE ON FUNCTION public.generate_recurring_invoice_occurrence(uuid, date, uuid, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.recurring_period_end(text, date) TO authenticated, service_role;

-- Authenticated "Generate now": permission-checked wrapper.
CREATE OR REPLACE FUNCTION public.generate_recurring_invoice_now(_recurring_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_ri record;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'auth required' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO v_ri FROM public.recurring_invoices WHERE id = _recurring_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Recurring template % not found', _recurring_id; END IF;
  IF NOT public.user_has_module_permission(auth.uid(), v_ri.organization_id, 'sales', 'create') THEN
    RAISE EXCEPTION 'Not authorized to generate invoices' USING ERRCODE = '42501';
  END IF;

  RETURN public.generate_recurring_invoice_occurrence(
    _recurring_id, v_ri.next_run_date, auth.uid(), 'manual');
END;
$$;

REVOKE ALL ON FUNCTION public.generate_recurring_invoice_now(uuid) FROM public;
GRANT EXECUTE ON FUNCTION public.generate_recurring_invoice_now(uuid) TO authenticated, service_role;