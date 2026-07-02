-- Odoo-grade finance hardening: reconciliation lifecycle, open-item residual views, and bank link scope validation.

-- 1) Complete write-off lifecycle columns referenced by the unreconcile RPC.
ALTER TABLE public.bank_reconciliation_writeoffs
  ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'draft',
  ADD COLUMN IF NOT EXISTS reversed_by uuid,
  ADD COLUMN IF NOT EXISTS reversed_at timestamptz,
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'bank_reconciliation_writeoffs_status_check'
      AND conrelid = 'public.bank_reconciliation_writeoffs'::regclass
  ) THEN
    ALTER TABLE public.bank_reconciliation_writeoffs
      ADD CONSTRAINT bank_reconciliation_writeoffs_status_check
      CHECK (status IN ('draft','posted','reversed'));
  END IF;
END $$;

DROP TRIGGER IF EXISTS trg_bank_recon_writeoffs_updated ON public.bank_reconciliation_writeoffs;
CREATE TRIGGER trg_bank_recon_writeoffs_updated
  BEFORE UPDATE ON public.bank_reconciliation_writeoffs
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE INDEX IF NOT EXISTS idx_bank_recon_writeoffs_status
  ON public.bank_reconciliation_writeoffs(status, reconciliation_match_id);

-- 2) Validate bank transaction accounting links are scoped to the same organization/company.
CREATE OR REPLACE FUNCTION public.validate_bank_transaction_accounting_scope()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_bank_account record;
  v_je record;
  v_payment record;
BEGIN
  SELECT organization_id, business_id INTO v_bank_account
  FROM public.bank_accounts
  WHERE id = NEW.bank_account_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Bank account not found for bank transaction';
  END IF;

  IF NEW.organization_id IS DISTINCT FROM v_bank_account.organization_id
     OR NEW.business_id IS DISTINCT FROM v_bank_account.business_id THEN
    RAISE EXCEPTION 'Bank transaction must belong to the same organization/company as its bank account';
  END IF;

  IF NEW.journal_entry_id IS NOT NULL THEN
    SELECT organization_id, business_id INTO v_je
    FROM public.journal_entries
    WHERE id = NEW.journal_entry_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Linked bank transaction journal entry not found';
    END IF;
    IF v_je.organization_id IS DISTINCT FROM NEW.organization_id
       OR v_je.business_id IS DISTINCT FROM NEW.business_id THEN
      RAISE EXCEPTION 'Bank transaction journal entry belongs to a different organization/company';
    END IF;
  END IF;

  IF NEW.reconciled_payment_id IS NOT NULL THEN
    SELECT organization_id, business_id INTO v_payment
    FROM public.payments
    WHERE id = NEW.reconciled_payment_id;

    IF NOT FOUND THEN
      SELECT organization_id, business_id INTO v_payment
      FROM public.bill_payments
      WHERE id = NEW.reconciled_payment_id;
    END IF;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Linked reconciled payment not found';
    END IF;

    IF v_payment.organization_id IS DISTINCT FROM NEW.organization_id
       OR v_payment.business_id IS DISTINCT FROM NEW.business_id THEN
      RAISE EXCEPTION 'Reconciled payment belongs to a different organization/company';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_bank_transactions_validate_accounting_scope ON public.bank_transactions;
CREATE TRIGGER trg_bank_transactions_validate_accounting_scope
  BEFORE INSERT OR UPDATE OF organization_id, business_id, bank_account_id, journal_entry_id, reconciled_payment_id
  ON public.bank_transactions
  FOR EACH ROW EXECUTE FUNCTION public.validate_bank_transaction_accounting_scope();

-- 3) Accountant-grade unreconcile: reverse reconciliation state, preserve source/import/payment evidence.
CREATE OR REPLACE FUNCTION public.unreconcile_bank_transaction(
  _bank_transaction_id uuid,
  _reason text DEFAULT NULL,
  _user_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _txn record;
  _match record;
  _writeoff record;
  _reversed_matches integer := 0;
  _reversed_writeoffs integer := 0;
  _voided_entries integer := 0;
BEGIN
  SELECT * INTO _txn FROM public.bank_transactions WHERE id = _bank_transaction_id FOR UPDATE;
  IF _txn.id IS NULL THEN
    RAISE EXCEPTION 'Bank transaction % not found', _bank_transaction_id;
  END IF;

  -- Reverse any direct reconciliation journal entry if present.
  IF _txn.journal_entry_id IS NOT NULL THEN
    PERFORM public.void_journal_entry_atomic(
      _txn.journal_entry_id,
      COALESCE(_reason, 'Bank transaction unreconciled'),
      _user_id,
      NULL,
      COALESCE(_txn.transaction_date, CURRENT_DATE)
    );
    _voided_entries := _voided_entries + 1;
  END IF;

  -- Reverse write-off journal entries attached to matches for this bank transaction.
  FOR _writeoff IN
    SELECT w.*
    FROM public.bank_reconciliation_writeoffs w
    JOIN public.bank_reconciliation_matches m ON m.id = w.reconciliation_match_id
    WHERE m.bank_transaction_id = _bank_transaction_id
      AND w.status IN ('draft','posted')
  LOOP
    IF _writeoff.journal_entry_id IS NOT NULL THEN
      PERFORM public.void_journal_entry_atomic(
        _writeoff.journal_entry_id,
        COALESCE(_reason, 'Bank reconciliation write-off unreconciled'),
        _user_id,
        COALESCE(_txn.transaction_date, CURRENT_DATE)
      );
      _voided_entries := _voided_entries + 1;
    END IF;
  END LOOP;

  UPDATE public.bank_reconciliation_writeoffs w
     SET status = 'reversed',
         reversed_by = _user_id,
         reversed_at = now(),
         updated_at = now()
    FROM public.bank_reconciliation_matches m
   WHERE w.reconciliation_match_id = m.id
     AND m.bank_transaction_id = _bank_transaction_id
     AND w.status IN ('draft','posted');
  GET DIAGNOSTICS _reversed_writeoffs = ROW_COUNT;

  UPDATE public.bank_reconciliation_matches
     SET status = 'reversed',
         reversed_by = _user_id,
         reversed_at = now(),
         notes = trim(both from concat_ws(' | ', notes, 'Unreconciled: ' || COALESCE(_reason, 'No reason provided'))),
         updated_at = now()
   WHERE bank_transaction_id = _bank_transaction_id
     AND status IN ('suggested','to_check','confirmed');
  GET DIAGNOSTICS _reversed_matches = ROW_COUNT;

  -- Preserve payment/bill_payment records. Mark customer payment audit state when the table supports it.
  IF _txn.reconciled_type = 'invoice' AND _txn.reconciled_payment_id IS NOT NULL THEN
    UPDATE public.payments
       SET status = 'unreconciled',
           unreconciled_at = now(),
           unreconciled_by = _user_id,
           unreconcile_reason = COALESCE(_reason, 'Bank transaction unreconciled')
     WHERE id = _txn.reconciled_payment_id;
  END IF;

  UPDATE public.bank_transactions
     SET is_reconciled = false,
         reconciled_type = NULL,
         reconciled_entity_id = NULL,
         reconciled_at = NULL,
         reconciled_by = NULL,
         journal_entry_id = NULL,
         reconciled_payment_id = NULL,
         match_confidence = NULL,
         match_source = 'unreconciled',
         lifecycle_status = 'for_review',
         updated_at = now()
   WHERE id = _bank_transaction_id;

  RETURN jsonb_build_object(
    'success', true,
    'bank_transaction_id', _bank_transaction_id,
    'reversed_matches', _reversed_matches,
    'reversed_writeoffs', _reversed_writeoffs,
    'voided_entries', _voided_entries,
    'reason', _reason
  );
END;
$$;

REVOKE ALL ON FUNCTION public.unreconcile_bank_transaction(uuid, text, uuid) FROM public;
GRANT EXECUTE ON FUNCTION public.unreconcile_bank_transaction(uuid, text, uuid) TO authenticated;

-- 4) Ledger-led open item views for AR/AP aging and tie-out checks.
CREATE OR REPLACE VIEW public.finance_ar_open_items
WITH (security_invoker = true) AS
SELECT
  inv.organization_id,
  inv.business_id,
  inv.branch_id,
  inv.id AS document_id,
  inv.invoice_number AS document_number,
  inv.contact_id,
  inv.issue_date AS document_date,
  inv.due_date,
  inv.total::numeric AS document_total,
  COALESCE(SUM(CASE WHEN p.status IS DISTINCT FROM 'voided' THEN p.amount ELSE 0 END), 0)::numeric AS applied_amount,
  (inv.total - COALESCE(SUM(CASE WHEN p.status IS DISTINCT FROM 'voided' THEN p.amount ELSE 0 END), 0))::numeric AS residual_amount,
  inv.status::text AS document_status,
  inv.journal_entry_id
FROM public.invoices inv
LEFT JOIN public.payments p ON p.invoice_id = inv.id
WHERE inv.status::text NOT IN ('draft','cancelled','voided')
GROUP BY inv.organization_id, inv.business_id, inv.branch_id, inv.id, inv.invoice_number, inv.contact_id, inv.issue_date, inv.due_date, inv.total, inv.status, inv.journal_entry_id
HAVING (inv.total - COALESCE(SUM(CASE WHEN p.status IS DISTINCT FROM 'voided' THEN p.amount ELSE 0 END), 0)) > 0.01;

CREATE OR REPLACE VIEW public.finance_ap_open_items
WITH (security_invoker = true) AS
SELECT
  b.organization_id,
  b.business_id,
  b.branch_id,
  b.id AS document_id,
  b.bill_number AS document_number,
  b.vendor_id AS contact_id,
  b.bill_date AS document_date,
  b.due_date,
  b.total::numeric AS document_total,
  COALESCE(SUM(bp.amount), 0)::numeric AS applied_amount,
  (b.total - COALESCE(SUM(bp.amount), 0))::numeric AS residual_amount,
  b.status::text AS document_status,
  b.journal_entry_id
FROM public.bills b
LEFT JOIN public.bill_payments bp ON bp.bill_id = b.id
WHERE b.status::text NOT IN ('draft','cancelled','voided')
GROUP BY b.organization_id, b.business_id, b.branch_id, b.id, b.bill_number, b.vendor_id, b.bill_date, b.due_date, b.total, b.status, b.journal_entry_id
HAVING (b.total - COALESCE(SUM(bp.amount), 0)) > 0.01;

GRANT SELECT ON public.finance_ar_open_items TO authenticated;
GRANT SELECT ON public.finance_ap_open_items TO authenticated;

CREATE OR REPLACE FUNCTION public.get_ar_ap_aging_from_ledger(
  _org_id uuid,
  _business_id uuid,
  _report_type text,
  _as_of_date date,
  _branch_id uuid DEFAULT NULL
)
RETURNS TABLE(
  contact_id uuid,
  contact_name text,
  company text,
  email text,
  document_id uuid,
  document_number text,
  document_date date,
  due_date date,
  document_total numeric,
  applied_amount numeric,
  residual_amount numeric,
  days_overdue integer,
  bucket text,
  journal_entry_id uuid
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH open_items AS (
    SELECT * FROM public.finance_ar_open_items WHERE _report_type = 'ar'
    UNION ALL
    SELECT * FROM public.finance_ap_open_items WHERE _report_type = 'ap'
  )
  SELECT
    oi.contact_id,
    c.name AS contact_name,
    c.company,
    c.email,
    oi.document_id,
    oi.document_number,
    oi.document_date,
    oi.due_date,
    oi.document_total,
    oi.applied_amount,
    oi.residual_amount,
    (_as_of_date - oi.due_date)::integer AS days_overdue,
    CASE
      WHEN (_as_of_date - oi.due_date)::integer < 0 THEN 'not_due'
      WHEN (_as_of_date - oi.due_date)::integer <= 30 THEN 'current'
      WHEN (_as_of_date - oi.due_date)::integer <= 60 THEN 'days30'
      WHEN (_as_of_date - oi.due_date)::integer <= 90 THEN 'days60'
      ELSE 'days90'
    END AS bucket,
    oi.journal_entry_id
  FROM open_items oi
  LEFT JOIN public.contacts c ON c.id = oi.contact_id
  WHERE oi.organization_id = _org_id
    AND oi.business_id = _business_id
    AND oi.document_date <= _as_of_date
    AND (_branch_id IS NULL OR oi.branch_id = _branch_id)
    AND oi.residual_amount > 0.01
  ORDER BY c.name NULLS LAST, oi.due_date, oi.document_number;
$$;

REVOKE ALL ON FUNCTION public.get_ar_ap_aging_from_ledger(uuid, uuid, text, date, uuid) FROM public;
GRANT EXECUTE ON FUNCTION public.get_ar_ap_aging_from_ledger(uuid, uuid, text, date, uuid) TO authenticated;

-- 5) Supplemental integrity findings for issues not covered by the original audit view.
CREATE OR REPLACE VIEW public.accounting_integrity_findings_supplemental
WITH (security_invoker = true) AS
SELECT gen_random_uuid() AS id, bt.organization_id, bt.business_id, NULL::uuid AS branch_id,
  'critical'::text AS severity,
  'bank_reconciled_without_confirmed_match'::text AS finding_code,
  'Bank transaction is marked reconciled without a confirmed reconciliation match'::text AS finding_title,
  format('Bank transaction %s is reconciled but has no confirmed match row.', bt.reference) AS finding_detail,
  'bank_transaction'::text AS entity_type,
  bt.id AS entity_id,
  bt.reference AS entity_ref,
  jsonb_build_object('bank_transaction_id', bt.id, 'reconciled_type', bt.reconciled_type, 'reconciled_entity_id', bt.reconciled_entity_id) AS evidence,
  now() AS detected_at
FROM public.bank_transactions bt
WHERE COALESCE(bt.is_reconciled, false) = true
  AND NOT EXISTS (
    SELECT 1 FROM public.bank_reconciliation_matches m
    WHERE m.bank_transaction_id = bt.id AND m.status IN ('confirmed','to_check')
  )
UNION ALL
SELECT gen_random_uuid(), ar.organization_id, ar.business_id, ar.branch_id,
  'critical', 'posted_invoice_missing_journal_entry',
  'Posted invoice has no linked posted journal entry',
  format('Invoice %s is %s but has no linked posted journal entry.', ar.document_number, ar.document_status),
  'invoice', ar.document_id, ar.document_number,
  jsonb_build_object('residual_amount', ar.residual_amount, 'journal_entry_id', ar.journal_entry_id), now()
FROM public.finance_ar_open_items ar
LEFT JOIN public.journal_entries je ON je.id = ar.journal_entry_id AND je.status = 'posted'
WHERE ar.journal_entry_id IS NULL OR je.id IS NULL
UNION ALL
SELECT gen_random_uuid(), ap.organization_id, ap.business_id, ap.branch_id,
  'critical', 'posted_bill_missing_journal_entry',
  'Posted bill has no linked posted journal entry',
  format('Bill %s is %s but has no linked posted journal entry.', ap.document_number, ap.document_status),
  'bill', ap.document_id, ap.document_number,
  jsonb_build_object('residual_amount', ap.residual_amount, 'journal_entry_id', ap.journal_entry_id), now()
FROM public.finance_ap_open_items ap
LEFT JOIN public.journal_entries je ON je.id = ap.journal_entry_id AND je.status = 'posted'
WHERE ap.journal_entry_id IS NULL OR je.id IS NULL
UNION ALL
SELECT gen_random_uuid(), je.organization_id, je.business_id, je.branch_id,
  'warning', 'legacy_direct_bank_recon_posting',
  'Legacy bank reconciliation journal entry may bypass the canonical match lifecycle',
  format('Journal entry %s uses legacy source type %s.', je.entry_number, je.source_type),
  'journal_entry', je.id, je.entry_number,
  jsonb_build_object('source_type', je.source_type, 'source_id', je.source_id), now()
FROM public.journal_entries je
WHERE je.status = 'posted'
  AND public.normalize_journal_source_type(je.source_type) IN ('bank_recon','bank_reconciliation')
  AND NOT EXISTS (
    SELECT 1 FROM public.bank_reconciliation_matches m
    WHERE m.matched_journal_entry_id = je.id
       OR m.bank_transaction_id = je.source_id
  );

GRANT SELECT ON public.accounting_integrity_findings_supplemental TO authenticated;

CREATE OR REPLACE FUNCTION public.get_accounting_integrity_findings(_include_supplemental boolean DEFAULT true)
RETURNS TABLE(
  id uuid,
  organization_id uuid,
  business_id uuid,
  branch_id uuid,
  severity text,
  finding_code text,
  finding_title text,
  finding_detail text,
  entity_type text,
  entity_id uuid,
  entity_ref text,
  evidence jsonb,
  detected_at timestamptz
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT * FROM public.accounting_integrity_findings
  UNION ALL
  SELECT * FROM public.accounting_integrity_findings_supplemental WHERE _include_supplemental;
$$;

REVOKE ALL ON FUNCTION public.get_accounting_integrity_findings(boolean) FROM public;
GRANT EXECUTE ON FUNCTION public.get_accounting_integrity_findings(boolean) TO authenticated;
