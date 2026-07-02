CREATE OR REPLACE VIEW public.accounting_integrity_findings
WITH (security_invoker = true) AS
WITH line_totals AS (
  SELECT
    je.id AS journal_entry_id,
    COUNT(jel.id) AS line_count,
    COALESCE(SUM(jel.debit), 0)::numeric AS debit_total,
    COALESCE(SUM(jel.credit), 0)::numeric AS credit_total
  FROM public.journal_entries je
  LEFT JOIN public.journal_entry_lines jel ON jel.journal_entry_id = je.id
  GROUP BY je.id
), ledger_balances AS (
  SELECT
    a.id AS account_id,
    SUM(
      CASE
        WHEN a.account_type IN ('asset', 'expense') THEN COALESCE(jel.debit,0) - COALESCE(jel.credit,0)
        ELSE COALESCE(jel.credit,0) - COALESCE(jel.debit,0)
      END
    )::numeric AS ledger_balance
  FROM public.accounts a
  LEFT JOIN public.journal_entry_lines jel ON jel.account_id = a.id
  LEFT JOIN public.journal_entries je ON je.id = jel.journal_entry_id AND je.status = 'posted'
  GROUP BY a.id
)
SELECT
  gen_random_uuid() AS id,
  je.organization_id,
  je.business_id,
  je.branch_id,
  'critical'::text AS severity,
  'journal_entry_unbalanced'::text AS finding_code,
  'Journal entry is not balanced from its posted line totals'::text AS finding_title,
  format('Entry %s has debit %s and credit %s.', je.entry_number, lt.debit_total, lt.credit_total) AS finding_detail,
  'journal_entry'::text AS entity_type,
  je.id AS entity_id,
  je.entry_number AS entity_ref,
  jsonb_build_object('debit_total', lt.debit_total, 'credit_total', lt.credit_total, 'line_count', lt.line_count) AS evidence,
  now() AS detected_at
FROM public.journal_entries je
JOIN line_totals lt ON lt.journal_entry_id = je.id
WHERE je.status IN ('posted','reversed')
  AND ABS(COALESCE(lt.debit_total,0) - COALESCE(lt.credit_total,0)) > 0.01

UNION ALL
SELECT
  gen_random_uuid(), je.organization_id, je.business_id, je.branch_id,
  'critical', 'journal_entry_insufficient_lines',
  'Journal entry has fewer than two lines',
  format('Entry %s has %s accounting line(s).', je.entry_number, COALESCE(lt.line_count,0)),
  'journal_entry', je.id, je.entry_number,
  jsonb_build_object('line_count', COALESCE(lt.line_count,0)), now()
FROM public.journal_entries je
JOIN line_totals lt ON lt.journal_entry_id = je.id
WHERE je.status IN ('posted','reversed') AND COALESCE(lt.line_count,0) < 2

UNION ALL
SELECT
  gen_random_uuid(), je.organization_id, je.business_id, je.branch_id,
  'critical', 'journal_line_account_business_mismatch',
  'Journal line uses an account from a different company',
  format('Entry %s line account %s belongs to a different company.', je.entry_number, a.code),
  'journal_entry', je.id, je.entry_number,
  jsonb_build_object('account_id', a.id, 'account_business_id', a.business_id, 'entry_business_id', je.business_id), now()
FROM public.journal_entry_lines jel
JOIN public.journal_entries je ON je.id = jel.journal_entry_id
JOIN public.accounts a ON a.id = jel.account_id
WHERE je.business_id IS NOT NULL
  AND a.business_id IS NOT NULL
  AND a.business_id <> je.business_id

UNION ALL
SELECT
  gen_random_uuid(), je.organization_id, je.business_id, je.branch_id,
  'critical', 'journal_branch_business_mismatch',
  'Journal entry branch does not belong to the journal entry company',
  format('Entry %s is assigned to a branch outside its company.', je.entry_number),
  'journal_entry', je.id, je.entry_number,
  jsonb_build_object('branch_id', je.branch_id, 'branch_business_id', br.business_id, 'entry_business_id', je.business_id), now()
FROM public.journal_entries je
JOIN public.branches br ON br.id = je.branch_id
WHERE je.business_id IS NOT NULL AND br.business_id <> je.business_id

UNION ALL
SELECT
  gen_random_uuid(), inv.organization_id, inv.business_id, inv.branch_id,
  'critical', 'posted_invoice_missing_journal_entry',
  'Posted customer invoice is not linked to a journal entry',
  format('Invoice %s is %s but has no linked posted journal entry.', inv.invoice_number, inv.status),
  'invoice', inv.id, inv.invoice_number,
  jsonb_build_object('status', inv.status, 'journal_entry_id', inv.journal_entry_id), now()
FROM public.invoices inv
LEFT JOIN public.journal_entries je
  ON je.organization_id = inv.organization_id
 AND je.source_type = 'invoice'
 AND je.source_id = inv.id
 AND je.status <> 'voided'
WHERE inv.status IN ('confirmed','sent','viewed','partial','paid','overdue')
  AND inv.journal_entry_id IS NULL
  AND je.id IS NULL

UNION ALL
SELECT
  gen_random_uuid(), inv.organization_id, inv.business_id, inv.branch_id,
  'critical', 'invoice_journal_business_branch_mismatch',
  'Invoice journal entry does not match invoice company or branch',
  format('Invoice %s is linked to a journal entry with inconsistent company or branch.', inv.invoice_number),
  'invoice', inv.id, inv.invoice_number,
  jsonb_build_object('invoice_business_id', inv.business_id, 'journal_business_id', je.business_id, 'invoice_branch_id', inv.branch_id, 'journal_branch_id', je.branch_id), now()
FROM public.invoices inv
JOIN public.journal_entries je ON je.id = inv.journal_entry_id
WHERE (je.business_id IS DISTINCT FROM inv.business_id OR je.branch_id IS DISTINCT FROM inv.branch_id)
  AND inv.status IN ('confirmed','sent','viewed','partial','paid','overdue')

UNION ALL
SELECT
  gen_random_uuid(), b.organization_id, b.business_id, b.branch_id,
  'critical', 'posted_bill_missing_journal_entry',
  'Posted vendor bill is not linked to a journal entry',
  format('Bill %s is %s but has no linked posted journal entry.', b.bill_number, b.status),
  'bill', b.id, b.bill_number,
  jsonb_build_object('status', b.status, 'journal_entry_id', b.journal_entry_id), now()
FROM public.bills b
LEFT JOIN public.journal_entries je
  ON je.organization_id = b.organization_id
 AND je.source_type = 'bill'
 AND je.source_id = b.id
 AND je.status <> 'voided'
WHERE b.status IN ('received','partial','paid','overdue')
  AND b.journal_entry_id IS NULL
  AND je.id IS NULL

UNION ALL
SELECT
  gen_random_uuid(), p.organization_id, p.business_id, p.branch_id,
  'critical', 'applied_payment_missing_journal_entry',
  'Applied customer payment is not linked to a journal entry',
  format('Payment %s is applied but has no linked journal entry.', COALESCE(p.receipt_number, p.id::text)),
  'payment', p.id, COALESCE(p.receipt_number, p.id::text),
  jsonb_build_object('status', p.status, 'invoice_id', p.invoice_id), now()
FROM public.payments p
LEFT JOIN public.journal_entries je
  ON je.organization_id = p.organization_id
 AND je.source_type = 'payment'
 AND je.source_id = p.id
 AND je.status <> 'voided'
WHERE COALESCE(p.status, 'applied') = 'applied'
  AND p.journal_entry_id IS NULL
  AND je.id IS NULL

UNION ALL
SELECT
  gen_random_uuid(), bp.organization_id, bp.business_id, bp.branch_id,
  'critical', 'bill_payment_missing_journal_entry',
  'Vendor payment is not linked to a journal entry',
  format('Bill payment %s has no linked journal entry.', bp.id),
  'bill_payment', bp.id, bp.id::text,
  jsonb_build_object('bill_id', bp.bill_id, 'amount', bp.amount), now()
FROM public.bill_payments bp
LEFT JOIN public.journal_entries je
  ON je.organization_id = bp.organization_id
 AND je.source_type = 'bill_payment'
 AND je.source_id = bp.id
 AND je.status <> 'voided'
WHERE bp.journal_entry_id IS NULL AND je.id IS NULL

UNION ALL
SELECT
  gen_random_uuid(), bt.organization_id, bt.business_id, ba.branch_id,
  'critical', 'reconciled_bank_transaction_missing_links',
  'Bank transaction is marked reconciled without a durable accounting link',
  format('Bank transaction %s is reconciled but lacks journal/payment/document linkage.', bt.id),
  'bank_transaction', bt.id, COALESCE(bt.reference, bt.id::text),
  jsonb_build_object('journal_entry_id', bt.journal_entry_id, 'reconciled_payment_id', bt.reconciled_payment_id, 'reconciled_entity_id', bt.reconciled_entity_id, 'reconciled_type', bt.reconciled_type), now()
FROM public.bank_transactions bt
LEFT JOIN public.bank_accounts ba ON ba.id = bt.bank_account_id
WHERE COALESCE(bt.is_reconciled, false) = true
  AND bt.journal_entry_id IS NULL
  AND bt.reconciled_payment_id IS NULL
  AND bt.reconciled_entity_id IS NULL

UNION ALL
SELECT
  gen_random_uuid(), je.organization_id, je.business_id, je.branch_id,
  'warning', 'posted_journal_entry_missing_journal_book',
  'Posted journal entry is not assigned to a journal book',
  format('Entry %s is posted without a journal book.', je.entry_number),
  'journal_entry', je.id, je.entry_number,
  jsonb_build_object('source_type', je.source_type, 'source_id', je.source_id), now()
FROM public.journal_entries je
WHERE je.status = 'posted' AND je.journal_book_id IS NULL

UNION ALL
SELECT
  gen_random_uuid(), je.organization_id, je.business_id, je.branch_id,
  'warning', 'bank_rule_direct_gl_posting',
  'Bank reconciliation rule created a direct GL posting',
  format('Entry %s was created directly by a reconciliation rule; verify it did not bypass suspense/outstanding reconciliation.', je.entry_number),
  'journal_entry', je.id, je.entry_number,
  jsonb_build_object('source_type', je.source_type, 'source_id', je.source_id), now()
FROM public.journal_entries je
WHERE je.source_type = 'bank_recon_rule' AND je.status = 'posted'

UNION ALL
SELECT
  gen_random_uuid(), a.organization_id, a.business_id, NULL::uuid,
  'warning', 'account_current_balance_drift',
  'Stored account balance differs from posted ledger balance',
  format('Account %s %s has stored balance %s but ledger balance %s.', a.code, a.name, COALESCE(a.current_balance,0), COALESCE(lb.ledger_balance,0)),
  'account', a.id, a.code,
  jsonb_build_object('stored_balance', COALESCE(a.current_balance,0), 'ledger_balance', COALESCE(lb.ledger_balance,0), 'drift', COALESCE(a.current_balance,0) - COALESCE(lb.ledger_balance,0)), now()
FROM public.accounts a
LEFT JOIN ledger_balances lb ON lb.account_id = a.id
WHERE ABS(COALESCE(a.current_balance,0) - COALESCE(lb.ledger_balance,0)) > 0.01;

CREATE OR REPLACE FUNCTION public.get_accounting_integrity_findings(
  _org_id uuid,
  _business_id uuid DEFAULT NULL,
  _branch_id uuid DEFAULT NULL,
  _severity text DEFAULT NULL,
  _limit integer DEFAULT 500
)
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
  SELECT
    f.id,
    f.organization_id,
    f.business_id,
    f.branch_id,
    f.severity,
    f.finding_code,
    f.finding_title,
    f.finding_detail,
    f.entity_type,
    f.entity_id,
    f.entity_ref,
    f.evidence,
    f.detected_at
  FROM public.accounting_integrity_findings f
  WHERE f.organization_id = _org_id
    AND (_business_id IS NULL OR f.business_id = _business_id)
    AND (_branch_id IS NULL OR f.branch_id = _branch_id OR f.branch_id IS NULL)
    AND (_severity IS NULL OR f.severity = _severity)
  ORDER BY
    CASE f.severity WHEN 'critical' THEN 1 WHEN 'warning' THEN 2 ELSE 3 END,
    f.finding_code,
    f.entity_ref
  LIMIT LEAST(GREATEST(COALESCE(_limit, 500), 1), 5000);
$$;