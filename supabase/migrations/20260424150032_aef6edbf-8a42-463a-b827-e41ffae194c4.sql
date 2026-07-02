-- Odoo-grade finance hardening follow-up: canonical reconciliation lifecycle and GL-ledger residuals.

CREATE OR REPLACE FUNCTION public.validate_bank_reconciliation_match_scope()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_txn record;
  v_je record;
  v_payment record;
  v_bill_payment record;
  v_rule record;
  v_has_writeoff boolean;
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.status = 'reversed' AND NEW.status <> 'reversed' THEN
    RAISE EXCEPTION 'Reversed reconciliation matches cannot be re-confirmed or reopened in-place';
  END IF;

  SELECT organization_id, business_id, branch_id INTO v_txn
  FROM public.bank_transactions
  WHERE id = NEW.bank_transaction_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Bank reconciliation match references a missing bank transaction';
  END IF;

  IF NEW.organization_id IS DISTINCT FROM v_txn.organization_id
     OR NEW.business_id IS DISTINCT FROM v_txn.business_id THEN
    RAISE EXCEPTION 'Bank reconciliation match must use the same organization/company as the bank transaction';
  END IF;

  IF NEW.branch_id IS NOT NULL AND v_txn.branch_id IS NOT NULL AND NEW.branch_id IS DISTINCT FROM v_txn.branch_id THEN
    RAISE EXCEPTION 'Bank reconciliation match branch must match the bank transaction branch';
  END IF;

  IF NEW.matched_journal_entry_id IS NOT NULL THEN
    SELECT organization_id, business_id, branch_id INTO v_je
    FROM public.journal_entries
    WHERE id = NEW.matched_journal_entry_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Matched journal entry not found';
    END IF;
    IF v_je.organization_id IS DISTINCT FROM NEW.organization_id
       OR v_je.business_id IS DISTINCT FROM NEW.business_id THEN
      RAISE EXCEPTION 'Matched journal entry belongs to a different organization/company';
    END IF;
    IF NEW.branch_id IS NOT NULL AND v_je.branch_id IS NOT NULL AND NEW.branch_id IS DISTINCT FROM v_je.branch_id THEN
      RAISE EXCEPTION 'Matched journal entry belongs to a different branch';
    END IF;
  END IF;

  IF NEW.matched_payment_id IS NOT NULL THEN
    SELECT organization_id, business_id INTO v_payment
    FROM public.payments
    WHERE id = NEW.matched_payment_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Matched customer payment not found';
    END IF;
    IF v_payment.organization_id IS DISTINCT FROM NEW.organization_id
       OR v_payment.business_id IS DISTINCT FROM NEW.business_id THEN
      RAISE EXCEPTION 'Matched customer payment belongs to a different organization/company';
    END IF;
  END IF;

  IF NEW.matched_bill_payment_id IS NOT NULL THEN
    SELECT organization_id, business_id INTO v_bill_payment
    FROM public.bill_payments
    WHERE id = NEW.matched_bill_payment_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Matched vendor payment not found';
    END IF;
    IF v_bill_payment.organization_id IS DISTINCT FROM NEW.organization_id
       OR v_bill_payment.business_id IS DISTINCT FROM NEW.business_id THEN
      RAISE EXCEPTION 'Matched vendor payment belongs to a different organization/company';
    END IF;
  END IF;

  IF NEW.rule_id IS NOT NULL THEN
    SELECT organization_id, business_id INTO v_rule
    FROM public.bank_reconciliation_rules
    WHERE id = NEW.rule_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Reconciliation rule not found';
    END IF;
    IF v_rule.organization_id IS DISTINCT FROM NEW.organization_id
       OR v_rule.business_id IS DISTINCT FROM NEW.business_id THEN
      RAISE EXCEPTION 'Reconciliation rule belongs to a different organization/company';
    END IF;
  END IF;

  IF NEW.status = 'confirmed' THEN
    SELECT EXISTS (
      SELECT 1 FROM public.bank_reconciliation_writeoffs w
      WHERE w.reconciliation_match_id = NEW.id
        AND w.status IN ('draft','posted')
    ) INTO v_has_writeoff;

    IF NEW.matched_journal_entry_id IS NULL
       AND NEW.matched_payment_id IS NULL
       AND NEW.matched_bill_payment_id IS NULL
       AND NEW.matched_entity_id IS NULL
       AND NOT v_has_writeoff THEN
      RAISE EXCEPTION 'Confirmed reconciliation matches require a matched payment, journal entry, source entity, or write-off';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_bank_reconciliation_matches_validate_scope ON public.bank_reconciliation_matches;
CREATE TRIGGER trg_bank_reconciliation_matches_validate_scope
  BEFORE INSERT OR UPDATE ON public.bank_reconciliation_matches
  FOR EACH ROW EXECUTE FUNCTION public.validate_bank_reconciliation_match_scope();

CREATE OR REPLACE FUNCTION public.validate_bank_reconciliation_writeoff_scope()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_match record;
  v_account record;
  v_je record;
BEGIN
  SELECT organization_id, business_id, branch_id INTO v_match
  FROM public.bank_reconciliation_matches
  WHERE id = NEW.reconciliation_match_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Bank reconciliation write-off references a missing match';
  END IF;

  SELECT organization_id, business_id INTO v_account
  FROM public.accounts
  WHERE id = NEW.account_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Bank reconciliation write-off account not found';
  END IF;
  IF v_account.organization_id IS DISTINCT FROM v_match.organization_id
     OR v_account.business_id IS DISTINCT FROM v_match.business_id THEN
    RAISE EXCEPTION 'Bank reconciliation write-off account belongs to a different organization/company';
  END IF;

  IF NEW.journal_entry_id IS NOT NULL THEN
    SELECT organization_id, business_id, branch_id INTO v_je
    FROM public.journal_entries
    WHERE id = NEW.journal_entry_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Bank reconciliation write-off journal entry not found';
    END IF;
    IF v_je.organization_id IS DISTINCT FROM v_match.organization_id
       OR v_je.business_id IS DISTINCT FROM v_match.business_id THEN
      RAISE EXCEPTION 'Bank reconciliation write-off journal entry belongs to a different organization/company';
    END IF;
    IF v_match.branch_id IS NOT NULL AND v_je.branch_id IS NOT NULL AND v_match.branch_id IS DISTINCT FROM v_je.branch_id THEN
      RAISE EXCEPTION 'Bank reconciliation write-off journal entry belongs to a different branch';
    END IF;
  END IF;

  IF TG_OP = 'UPDATE' AND OLD.status = 'reversed' AND NEW.status <> 'reversed' THEN
    RAISE EXCEPTION 'Reversed bank reconciliation write-offs cannot be reopened in-place';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_bank_reconciliation_writeoffs_validate_scope ON public.bank_reconciliation_writeoffs;
CREATE TRIGGER trg_bank_reconciliation_writeoffs_validate_scope
  BEFORE INSERT OR UPDATE ON public.bank_reconciliation_writeoffs
  FOR EACH ROW EXECUTE FUNCTION public.validate_bank_reconciliation_writeoff_scope();

CREATE OR REPLACE VIEW public.finance_ar_open_items
WITH (security_invoker = true) AS
WITH ar_lines AS (
  SELECT
    je.organization_id,
    je.business_id,
    COALESCE(jel.branch_id, je.branch_id) AS branch_id,
    COALESCE(jel.contact_id, inv.contact_id) AS contact_id,
    COALESCE(je.source_id, inv.id) AS document_id,
    COALESCE(inv.invoice_number, je.reference, je.entry_number) AS document_number,
    COALESCE(inv.issue_date, je.entry_date) AS document_date,
    COALESCE(inv.due_date, je.entry_date) AS due_date,
    COALESCE(inv.total, 0)::numeric AS document_total,
    je.id AS journal_entry_id,
    COALESCE(inv.status::text, je.status::text) AS document_status,
    SUM(COALESCE(jel.debit, 0) - COALESCE(jel.credit, 0))::numeric AS residual_amount
  FROM public.journal_entry_lines jel
  JOIN public.journal_entries je ON je.id = jel.journal_entry_id
  JOIN public.accounts a ON a.id = jel.account_id
  LEFT JOIN public.invoices inv
    ON inv.id = je.source_id
   AND public.normalize_journal_source_type(je.source_type) = 'invoice'
  WHERE je.status = 'posted'
    AND a.account_type = 'asset'
    AND (a.detail_type = 'accounts_receivable' OR lower(a.name) LIKE '%receivable%')
  GROUP BY je.organization_id, je.business_id, COALESCE(jel.branch_id, je.branch_id),
           COALESCE(jel.contact_id, inv.contact_id), COALESCE(je.source_id, inv.id),
           COALESCE(inv.invoice_number, je.reference, je.entry_number), COALESCE(inv.issue_date, je.entry_date),
           COALESCE(inv.due_date, je.entry_date), COALESCE(inv.total, 0), je.id, COALESCE(inv.status::text, je.status::text)
)
SELECT
  organization_id,
  business_id,
  branch_id,
  document_id,
  document_number,
  contact_id,
  document_date,
  due_date,
  document_total,
  GREATEST(document_total - residual_amount, 0)::numeric AS applied_amount,
  residual_amount,
  document_status,
  journal_entry_id
FROM ar_lines
WHERE residual_amount > 0.01;

CREATE OR REPLACE VIEW public.finance_ap_open_items
WITH (security_invoker = true) AS
WITH ap_lines AS (
  SELECT
    je.organization_id,
    je.business_id,
    COALESCE(jel.branch_id, je.branch_id) AS branch_id,
    COALESCE(jel.contact_id, b.vendor_id) AS contact_id,
    COALESCE(je.source_id, b.id) AS document_id,
    COALESCE(b.bill_number, je.reference, je.entry_number) AS document_number,
    COALESCE(b.bill_date, je.entry_date) AS document_date,
    COALESCE(b.due_date, je.entry_date) AS due_date,
    COALESCE(b.total, 0)::numeric AS document_total,
    je.id AS journal_entry_id,
    COALESCE(b.status::text, je.status::text) AS document_status,
    SUM(COALESCE(jel.credit, 0) - COALESCE(jel.debit, 0))::numeric AS residual_amount
  FROM public.journal_entry_lines jel
  JOIN public.journal_entries je ON je.id = jel.journal_entry_id
  JOIN public.accounts a ON a.id = jel.account_id
  LEFT JOIN public.bills b
    ON b.id = je.source_id
   AND public.normalize_journal_source_type(je.source_type) = 'bill'
  WHERE je.status = 'posted'
    AND a.account_type = 'liability'
    AND (a.detail_type = 'accounts_payable' OR lower(a.name) LIKE '%payable%')
  GROUP BY je.organization_id, je.business_id, COALESCE(jel.branch_id, je.branch_id),
           COALESCE(jel.contact_id, b.vendor_id), COALESCE(je.source_id, b.id),
           COALESCE(b.bill_number, je.reference, je.entry_number), COALESCE(b.bill_date, je.entry_date),
           COALESCE(b.due_date, je.entry_date), COALESCE(b.total, 0), je.id, COALESCE(b.status::text, je.status::text)
)
SELECT
  organization_id,
  business_id,
  branch_id,
  document_id,
  document_number,
  contact_id,
  document_date,
  due_date,
  document_total,
  GREATEST(document_total - residual_amount, 0)::numeric AS applied_amount,
  residual_amount,
  document_status,
  journal_entry_id
FROM ap_lines
WHERE residual_amount > 0.01;

GRANT SELECT ON public.finance_ar_open_items TO authenticated;
GRANT SELECT ON public.finance_ap_open_items TO authenticated;

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
SELECT gen_random_uuid(), m.organization_id, m.business_id, m.branch_id,
  'critical', 'confirmed_reconciliation_match_without_source',
  'Confirmed bank reconciliation match has no matched accounting source',
  format('Match %s is confirmed but has no payment, bill payment, journal entry, source entity, or write-off.', m.id),
  'bank_reconciliation_match', m.id, m.id::text,
  jsonb_build_object('bank_transaction_id', m.bank_transaction_id, 'match_type', m.match_type, 'status', m.status), now()
FROM public.bank_reconciliation_matches m
WHERE m.status = 'confirmed'
  AND m.matched_journal_entry_id IS NULL
  AND m.matched_payment_id IS NULL
  AND m.matched_bill_payment_id IS NULL
  AND m.matched_entity_id IS NULL
  AND NOT EXISTS (
    SELECT 1 FROM public.bank_reconciliation_writeoffs w
    WHERE w.reconciliation_match_id = m.id AND w.status IN ('draft','posted')
  )
UNION ALL
SELECT gen_random_uuid(), m.organization_id, m.business_id, m.branch_id,
  'critical', 'writeoff_journal_state_mismatch',
  'Bank reconciliation write-off journal entry state does not match lifecycle state',
  format('Write-off %s has status %s but journal entry is missing or not posted/reversed consistently.', w.id, w.status),
  'bank_reconciliation_writeoff', w.id, w.id::text,
  jsonb_build_object('match_id', m.id, 'journal_entry_id', w.journal_entry_id, 'writeoff_status', w.status, 'journal_status', je.status), now()
FROM public.bank_reconciliation_writeoffs w
JOIN public.bank_reconciliation_matches m ON m.id = w.reconciliation_match_id
LEFT JOIN public.journal_entries je ON je.id = w.journal_entry_id
WHERE (w.status = 'posted' AND (w.journal_entry_id IS NULL OR je.status IS DISTINCT FROM 'posted'))
   OR (w.status = 'reversed' AND w.journal_entry_id IS NOT NULL AND je.status = 'posted')
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
SELECT gen_random_uuid(), p.organization_id, p.business_id, NULL::uuid,
  'critical', 'customer_payment_missing_posted_journal_entry',
  'Customer payment is applied without a posted journal entry',
  format('Payment %s is applied but has no linked posted journal entry.', COALESCE(p.receipt_number, p.id::text)),
  'payment', p.id, COALESCE(p.receipt_number, p.id::text),
  jsonb_build_object('invoice_id', p.invoice_id, 'amount', p.amount, 'journal_entry_id', p.journal_entry_id, 'journal_status', je.status), now()
FROM public.payments p
LEFT JOIN public.journal_entries je ON je.id = p.journal_entry_id
WHERE COALESCE(p.status::text, '') NOT IN ('voided','cancelled','unreconciled')
  AND (p.journal_entry_id IS NULL OR je.status IS DISTINCT FROM 'posted')
UNION ALL
SELECT gen_random_uuid(), bp.organization_id, bp.business_id, NULL::uuid,
  'critical', 'vendor_payment_missing_posted_journal_entry',
  'Vendor payment is applied without a posted journal entry',
  format('Bill payment %s is applied but has no linked posted journal entry.', bp.id),
  'bill_payment', bp.id, bp.id::text,
  jsonb_build_object('bill_id', bp.bill_id, 'amount', bp.amount, 'journal_entry_id', bp.journal_entry_id, 'journal_status', je.status), now()
FROM public.bill_payments bp
LEFT JOIN public.journal_entries je ON je.id = bp.journal_entry_id
WHERE bp.journal_entry_id IS NULL OR je.status IS DISTINCT FROM 'posted'
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