-- ---------------------------------------------------------------------------
-- Reversal preview: document-specific enrichment for expense & customer_refund
--
-- `preview_reversal_consequences_core` is generic for GL (it reverses journal
-- lines by source_type/source_id) and has hand-written branches for invoice,
-- payment, bill and goods_receipt. Expense and customer_refund gained intent
-- resolvers (ADR 0134) but no preview branch, so the confirmation sheet showed
-- the journal and nothing else — understating what the void actually does.
--
-- Rather than growing the core monolith, each document type gets a dedicated
-- extras resolver, mirroring the `resolve_reversal_intent_<type>` shape that is
-- now the canonical pattern. The wrapper dispatches and merges. No new preview
-- engine, no client-side derivation.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.preview_reversal_extras_expense(_document_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  e             public.expenses%ROWTYPE;
  v_money       jsonb := '[]'::jsonb;
  v_docs        jsonb := '[]'::jsonb;
  v_warnings    jsonb := '[]'::jsonb;
  v_analytic_n  int := 0;
  v_analytic_t  numeric := 0;
  v_project_n   int := 0;
  v_project_t   numeric := 0;
  v_bill_id     uuid;
  v_bill_number text;
  v_reimbursed  boolean;
  v_queued      boolean;
BEGIN
  SELECT * INTO e FROM public.expenses WHERE id = _document_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('money', v_money, 'related_documents', v_docs, 'warnings', v_warnings);
  END IF;

  -- Analytic distributions withdrawn with the expense.
  SELECT count(*), COALESCE(SUM(ad.amount), 0)
    INTO v_analytic_n, v_analytic_t
    FROM public.analytic_distributions ad
   WHERE ad.source_type = 'expense'
     AND ad.source_id   = _document_id;

  -- Project cost entries withdrawn with the expense.
  SELECT count(*), COALESCE(SUM(pce.amount), 0)
    INTO v_project_n, v_project_t
    FROM public.project_cost_entries pce
   WHERE pce.source_type = 'expense'
     AND pce.source_id   = _document_id;

  SELECT b.id, b.bill_number INTO v_bill_id, v_bill_number
    FROM public.bills b
   WHERE b.source_expense_id = _document_id
     AND b.status <> 'void'
   LIMIT 1;

  v_docs := jsonb_build_array(
    jsonb_build_object('kind', 'analytic_distribution',
                       'label', 'Cost allocations withdrawn', 'count', v_analytic_n),
    jsonb_build_object('kind', 'project_cost_entry',
                       'label', 'Project cost entries withdrawn', 'count', v_project_n),
    jsonb_build_object('kind', 'bill',
                       'label', 'Supplier bills raised from this expense',
                       'count', CASE WHEN v_bill_id IS NULL THEN 0 ELSE 1 END));

  v_reimbursed := e.reimbursed_at IS NOT NULL OR e.reimbursed_payslip_id IS NOT NULL;
  v_queued := COALESCE(e.reimburse_via_payroll, false)
              AND e.reimbursed_payslip_id IS NULL
              AND NOT v_reimbursed;

  -- The employee payable this void cancels. Shaped as a money "payment" line so
  -- the shared preview renders it without a document-specific fork.
  IF e.employee_id IS NOT NULL AND NOT v_reimbursed THEN
    v_money := v_money || jsonb_build_array(jsonb_build_object(
      'payment_id',        _document_id,
      'receipt_number',    'Employee reimbursement owed',
      'allocated_amount',  COALESCE(e.amount, 0),
      'bank_reconciled',   false));
  END IF;

  IF v_queued THEN
    v_warnings := v_warnings || jsonb_build_object(
      'code', 'expense_queued_for_payroll',
      'severity', 'error',
      'message', 'This expense is still queued for payroll reimbursement. Voiding it reverses the liability out of the ledger while the payroll run would still pay the employee — remove it from the payroll queue first.');
  END IF;

  IF v_analytic_n > 0 OR v_project_n > 0 THEN
    v_warnings := v_warnings || jsonb_build_object(
      'code', 'expense_cost_allocations_withdrawn',
      'severity', 'info',
      'message', v_analytic_n || ' cost allocation(s) and ' || v_project_n ||
                 ' project cost entry(ies) totalling ' ||
                 to_char(GREATEST(v_analytic_t, v_project_t), 'FM999999999990.00') ||
                 ' are withdrawn with this reversal, so cost-centre and project reporting change.');
  END IF;

  IF v_bill_id IS NOT NULL THEN
    v_warnings := v_warnings || jsonb_build_object(
      'code', 'expense_already_billed',
      'severity', 'error',
      'message', 'A live supplier bill (' || COALESCE(v_bill_number, 'draft') ||
                 ') owns this liability. Void that bill instead.');
  END IF;

  RETURN jsonb_build_object('money', v_money, 'related_documents', v_docs, 'warnings', v_warnings);
END $function$;

CREATE OR REPLACE FUNCTION public.preview_reversal_extras_customer_refund(_document_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  r          public.customer_refunds%ROWTYPE;
  v_money    jsonb := '[]'::jsonb;
  v_docs     jsonb := '[]'::jsonb;
  v_warnings jsonb := '[]'::jsonb;
  v_bank     text;
BEGIN
  SELECT * INTO r FROM public.customer_refunds WHERE id = _document_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('money', v_money, 'related_documents', v_docs, 'warnings', v_warnings);
  END IF;

  SELECT ba.account_name INTO v_bank
    FROM public.bank_accounts ba
   WHERE ba.id = r.bank_account_id;

  v_money := jsonb_build_array(jsonb_build_object(
    'payment_id',       _document_id,
    'receipt_number',   'Refund from ' || COALESCE(v_bank, 'bank account'),
    'allocated_amount', COALESCE(r.amount, 0),
    'bank_reconciled',  false));

  v_docs := jsonb_build_array(
    jsonb_build_object('kind', 'payment', 'label', 'Customer receipt refunded',
                       'count', CASE WHEN r.source_payment_id IS NULL THEN 0 ELSE 1 END),
    jsonb_build_object('kind', 'credit_note', 'label', 'Credit note drawn down',
                       'count', CASE WHEN r.source_credit_note_id IS NULL THEN 0 ELSE 1 END));

  v_warnings := v_warnings || jsonb_build_object(
    'code', 'refund_cash_already_left',
    'severity', 'warning',
    'message', 'The refunded money has already left the bank. Reversing this record does not recall the funds — record a customer receipt when the money comes back.');

  RETURN jsonb_build_object('money', v_money, 'related_documents', v_docs, 'warnings', v_warnings);
END $function$;

-- Wrapper: dispatch to the per-type extras resolver and merge into the base.
CREATE OR REPLACE FUNCTION public.preview_reversal_consequences(_document_type text, _document_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_base        jsonb;
  v_warnings    jsonb;
  v_tasks       jsonb := '[]'::jsonb;
  v_bank        jsonb := '[]'::jsonb;
  v_in_progress int := 0;
  v_extras      jsonb := NULL;
  v_money       jsonb;
  v_docs        jsonb;
BEGIN
  v_base := public.preview_reversal_consequences_core(_document_type, _document_id);
  v_warnings := COALESCE(v_base->'warnings', '[]'::jsonb);
  v_money := COALESCE(v_base->'money'->'lines', '[]'::jsonb);
  v_docs  := COALESCE(v_base->'related_documents', '[]'::jsonb);

  -- Document-specific enrichment (ADR 0134 follow-up). One resolver per type,
  -- same convention as resolve_reversal_intent_<type>.
  IF _document_type = 'expense' THEN
    v_extras := public.preview_reversal_extras_expense(_document_id);
  ELSIF _document_type = 'customer_refund' THEN
    v_extras := public.preview_reversal_extras_customer_refund(_document_id);
  END IF;

  IF v_extras IS NOT NULL THEN
    v_money    := v_money    || COALESCE(v_extras->'money', '[]'::jsonb);
    v_docs     := v_docs     || COALESCE(v_extras->'related_documents', '[]'::jsonb);
    v_warnings := v_warnings || COALESCE(v_extras->'warnings', '[]'::jsonb);
  END IF;

  -- Warehouse tasks that the reversal would cancel.
  v_tasks := public.wms_open_tasks_for_document(_document_type, _document_id);

  SELECT count(*) INTO v_in_progress
    FROM jsonb_array_elements(v_tasks) t
   WHERE t->>'state' IN ('in_progress','claimed','paused','resumed');

  IF jsonb_array_length(v_tasks) > 0 THEN
    v_warnings := v_warnings || jsonb_build_object(
      'code', 'warehouse_tasks_cancelled',
      'severity', CASE WHEN v_in_progress > 0 THEN 'warning' ELSE 'info' END,
      'message', jsonb_array_length(v_tasks) || ' open warehouse task(s) belong to this document and would be cancelled'
                 || CASE WHEN v_in_progress > 0
                         THEN ', including ' || v_in_progress || ' already being worked on the floor.'
                         ELSE '.' END);
  END IF;

  -- Bank statement lines that must be un-matched before the reversal.
  v_bank := public.reversal_bank_lines(_document_type, _document_id);

  IF jsonb_array_length(v_bank) > 0 THEN
    v_warnings := v_warnings || jsonb_build_object(
      'code', 'bank_lines_matched',
      'severity', 'error',
      'message', jsonb_array_length(v_bank) || ' reconciled bank statement line(s) are matched to this document''s payment(s). Un-match them first, or the bank reconciliation and the ledger will disagree.');
  END IF;

  RETURN v_base
    || jsonb_build_object(
         'money', jsonb_build_object(
                    'lines', v_money,
                    'line_count', jsonb_array_length(v_money)),
         'related_documents', v_docs,
         'warehouse', jsonb_build_object(
                        'tasks', v_tasks,
                        'task_count', jsonb_array_length(v_tasks),
                        'in_progress_count', v_in_progress),
         'bank', jsonb_build_object(
                   'lines', v_bank,
                   'line_count', jsonb_array_length(v_bank)),
         'warnings', v_warnings);
END $function$;

REVOKE ALL ON FUNCTION public.preview_reversal_extras_expense(uuid) FROM public;
REVOKE ALL ON FUNCTION public.preview_reversal_extras_customer_refund(uuid) FROM public;
GRANT EXECUTE ON FUNCTION public.preview_reversal_extras_expense(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.preview_reversal_extras_customer_refund(uuid) TO authenticated;

NOTIFY pgrst, 'reload schema';