
CREATE OR REPLACE VIEW public.accounting_integrity_findings
WITH (security_invoker = true) AS
WITH line_totals AS (
  SELECT je.id AS journal_entry_id, COUNT(jel.id) AS line_count,
         COALESCE(SUM(jel.debit), 0)::numeric AS debit_total,
         COALESCE(SUM(jel.credit), 0)::numeric AS credit_total
  FROM public.journal_entries je
  LEFT JOIN public.journal_entry_lines jel ON jel.journal_entry_id = je.id
  GROUP BY je.id
), ledger_balances AS (
  SELECT a.id AS account_id,
         SUM(CASE WHEN a.account_type IN ('asset', 'expense') THEN COALESCE(jel.debit,0) - COALESCE(jel.credit,0)
                  ELSE COALESCE(jel.credit,0) - COALESCE(jel.debit,0) END)::numeric AS ledger_balance
  FROM public.accounts a
  LEFT JOIN public.journal_entry_lines jel ON jel.account_id = a.id
  LEFT JOIN public.journal_entries je ON je.id = jel.journal_entry_id AND je.status = 'posted'
  GROUP BY a.id
)
SELECT gen_random_uuid() AS id, je.organization_id, je.business_id, je.branch_id,
  'critical'::text AS severity, 'journal_entry_unbalanced'::text AS finding_code,
  'Journal entry is not balanced from its posted line totals'::text AS finding_title,
  format('Entry %s has debit %s and credit %s.', je.entry_number, lt.debit_total, lt.credit_total) AS finding_detail,
  'journal_entry'::text AS entity_type, je.id AS entity_id, je.entry_number AS entity_ref,
  jsonb_build_object('debit_total', lt.debit_total, 'credit_total', lt.credit_total, 'line_count', lt.line_count) AS evidence, now() AS detected_at
FROM public.journal_entries je
JOIN line_totals lt ON lt.journal_entry_id = je.id
WHERE je.status IN ('posted','reversed') AND ABS(COALESCE(lt.debit_total,0) - COALESCE(lt.credit_total,0)) > 0.01
UNION ALL
SELECT gen_random_uuid(), je.organization_id, je.business_id, je.branch_id, 'critical', 'journal_entry_insufficient_lines',
  'Journal entry has fewer than two lines', format('Entry %s has %s accounting line(s).', je.entry_number, COALESCE(lt.line_count,0)),
  'journal_entry', je.id, je.entry_number, jsonb_build_object('line_count', COALESCE(lt.line_count,0)), now()
FROM public.journal_entries je JOIN line_totals lt ON lt.journal_entry_id = je.id
WHERE je.status IN ('posted','reversed') AND COALESCE(lt.line_count,0) < 2
UNION ALL
SELECT gen_random_uuid(), je.organization_id, je.business_id, je.branch_id, 'critical', 'journal_line_account_business_mismatch',
  'Journal line uses an account from a different company', format('Entry %s line account %s belongs to a different company.', je.entry_number, a.code),
  'journal_entry', je.id, je.entry_number, jsonb_build_object('account_id', a.id, 'account_business_id', a.business_id, 'entry_business_id', je.business_id), now()
FROM public.journal_entry_lines jel JOIN public.journal_entries je ON je.id = jel.journal_entry_id JOIN public.accounts a ON a.id = jel.account_id
WHERE je.business_id IS NOT NULL AND a.business_id IS NOT NULL AND a.business_id <> je.business_id
UNION ALL
SELECT gen_random_uuid(), je.organization_id, je.business_id, je.branch_id, 'critical', 'journal_line_scope_mismatch',
  'Journal line company or branch does not match its parent journal entry', format('Entry %s has at least one line with mismatched company or branch.', je.entry_number),
  'journal_entry', je.id, je.entry_number, jsonb_build_object('entry_business_id', je.business_id, 'entry_branch_id', je.branch_id, 'line_business_id', jel.business_id, 'line_branch_id', jel.branch_id), now()
FROM public.journal_entry_lines jel JOIN public.journal_entries je ON je.id = jel.journal_entry_id
WHERE jel.business_id IS DISTINCT FROM je.business_id OR jel.branch_id IS DISTINCT FROM je.branch_id
UNION ALL
SELECT gen_random_uuid(), je.organization_id, je.business_id, je.branch_id, 'critical', 'journal_branch_business_mismatch',
  'Journal entry branch does not belong to the journal entry company', format('Entry %s is assigned to a branch outside its company.', je.entry_number),
  'journal_entry', je.id, je.entry_number, jsonb_build_object('branch_id', je.branch_id, 'branch_business_id', br.business_id, 'entry_business_id', je.business_id), now()
FROM public.journal_entries je JOIN public.branches br ON br.id = je.branch_id
WHERE je.business_id IS NOT NULL AND br.business_id <> je.business_id
UNION ALL
SELECT gen_random_uuid(), inv.organization_id, inv.business_id, inv.branch_id, 'critical', 'posted_invoice_missing_journal_entry',
  'Posted customer invoice is not linked to a journal entry', format('Invoice %s is %s but has no linked posted journal entry.', inv.invoice_number, inv.status),
  'invoice', inv.id, inv.invoice_number, jsonb_build_object('status', inv.status, 'journal_entry_id', inv.journal_entry_id), now()
FROM public.invoices inv
LEFT JOIN public.journal_entries je ON je.organization_id = inv.organization_id AND je.source_type = 'invoice' AND je.source_id = inv.id AND je.status <> 'voided'
WHERE inv.status IN ('confirmed','sent','viewed','partial','paid','overdue') AND inv.journal_entry_id IS NULL AND je.id IS NULL
UNION ALL
SELECT gen_random_uuid(), inv.organization_id, inv.business_id, inv.branch_id, 'critical', 'invoice_journal_business_branch_mismatch',
  'Invoice journal entry does not match invoice company or branch', format('Invoice %s is linked to a journal entry with inconsistent company or branch.', inv.invoice_number),
  'invoice', inv.id, inv.invoice_number, jsonb_build_object('invoice_business_id', inv.business_id, 'journal_business_id', je.business_id, 'invoice_branch_id', inv.branch_id, 'journal_branch_id', je.branch_id), now()
FROM public.invoices inv JOIN public.journal_entries je ON je.id = inv.journal_entry_id
WHERE (je.business_id IS DISTINCT FROM inv.business_id OR je.branch_id IS DISTINCT FROM inv.branch_id) AND inv.status IN ('confirmed','sent','viewed','partial','paid','overdue')
UNION ALL
SELECT gen_random_uuid(), b.organization_id, b.business_id, b.branch_id, 'critical', 'posted_bill_missing_journal_entry',
  'Posted vendor bill is not linked to a journal entry', format('Bill %s is %s but has no linked posted journal entry.', b.bill_number, b.status),
  'bill', b.id, b.bill_number, jsonb_build_object('status', b.status, 'journal_entry_id', b.journal_entry_id), now()
FROM public.bills b
LEFT JOIN public.journal_entries je ON je.organization_id = b.organization_id AND je.source_type = 'bill' AND je.source_id = b.id AND je.status <> 'voided'
WHERE b.status IN ('received','partial','paid','overdue') AND b.journal_entry_id IS NULL AND je.id IS NULL
UNION ALL
SELECT gen_random_uuid(), p.organization_id, p.business_id, p.branch_id, 'critical', 'applied_payment_missing_journal_entry',
  'Applied customer payment is not linked to a journal entry', format('Payment %s is applied but has no linked journal entry.', COALESCE(p.receipt_number, p.id::text)),
  'payment', p.id, COALESCE(p.receipt_number, p.id::text), jsonb_build_object('status', p.status, 'contact_id', p.contact_id), now()
FROM public.payments p
LEFT JOIN public.journal_entries je ON je.organization_id = p.organization_id AND je.source_type = 'payment' AND je.source_id = p.id AND je.status <> 'voided'
WHERE COALESCE(p.status, 'applied') = 'applied' AND p.journal_entry_id IS NULL AND je.id IS NULL
UNION ALL
SELECT gen_random_uuid(), bp.organization_id, bp.business_id, bp.branch_id, 'critical', 'bill_payment_missing_journal_entry',
  'Vendor payment is not linked to a journal entry', format('Bill payment %s has no linked journal entry.', bp.id),
  'bill_payment', bp.id, bp.id::text, jsonb_build_object('amount', bp.amount, 'payment_date', bp.payment_date), now()
FROM public.bill_payments bp
LEFT JOIN public.journal_entries je ON je.organization_id = bp.organization_id AND je.source_type = 'bill_payment' AND je.source_id = bp.id AND je.status <> 'voided'
WHERE bp.journal_entry_id IS NULL AND je.id IS NULL
UNION ALL
SELECT gen_random_uuid(), bt.organization_id, bt.business_id, ba.branch_id, 'critical', 'reconciled_bank_transaction_missing_links',
  'Bank transaction is marked reconciled without a durable accounting link', format('Bank transaction %s is reconciled but lacks journal/payment/document/reconciliation-match linkage.', bt.id),
  'bank_transaction', bt.id, COALESCE(bt.reference, bt.id::text), jsonb_build_object('journal_entry_id', bt.journal_entry_id, 'reconciled_payment_id', bt.reconciled_payment_id, 'reconciled_entity_id', bt.reconciled_entity_id, 'match_count', COUNT(m.id)), now()
FROM public.bank_transactions bt
LEFT JOIN public.bank_accounts ba ON ba.id = bt.bank_account_id
LEFT JOIN public.bank_reconciliation_matches m ON m.bank_transaction_id = bt.id AND m.status IN ('confirmed','to_check')
WHERE COALESCE(bt.is_reconciled, false) = true AND bt.journal_entry_id IS NULL AND bt.reconciled_payment_id IS NULL AND bt.reconciled_entity_id IS NULL
GROUP BY bt.id, bt.organization_id, bt.business_id, ba.branch_id, bt.reference, bt.journal_entry_id, bt.reconciled_payment_id, bt.reconciled_entity_id
HAVING COUNT(m.id) = 0
UNION ALL
SELECT gen_random_uuid(), je.organization_id, je.business_id, je.branch_id, 'warning', 'posted_journal_entry_missing_journal_book',
  'Posted journal entry is not assigned to a journal book', format('Entry %s is posted without a journal book.', je.entry_number),
  'journal_entry', je.id, je.entry_number, jsonb_build_object('source_type', je.source_type, 'source_id', je.source_id), now()
FROM public.journal_entries je WHERE je.status = 'posted' AND je.journal_book_id IS NULL
UNION ALL
SELECT gen_random_uuid(), je.organization_id, je.business_id, je.branch_id, 'warning', 'legacy_bank_rule_direct_gl_posting',
  'Legacy bank reconciliation rule created a direct GL posting', format('Entry %s was created directly by a legacy reconciliation rule; verify it did not bypass suspense/outstanding reconciliation.', je.entry_number),
  'journal_entry', je.id, je.entry_number, jsonb_build_object('source_type', je.source_type, 'source_id', je.source_id), now()
FROM public.journal_entries je WHERE je.source_type IN ('bank_recon_rule','bank_rule') AND je.status = 'posted'
UNION ALL
SELECT gen_random_uuid(), bt.organization_id, bt.business_id, ba.branch_id, 'warning', 'bank_transaction_has_suggested_match',
  'Bank transaction has a reconciliation suggestion awaiting review', format('Bank transaction %s has suggested reconciliation matches.', COALESCE(bt.reference, bt.id::text)),
  'bank_transaction', bt.id, COALESCE(bt.reference, bt.id::text), jsonb_build_object('suggestions', COUNT(m.id)), now()
FROM public.bank_transactions bt
LEFT JOIN public.bank_accounts ba ON ba.id = bt.bank_account_id
JOIN public.bank_reconciliation_matches m ON m.bank_transaction_id = bt.id AND m.status IN ('suggested','to_check')
GROUP BY bt.id, bt.organization_id, bt.business_id, ba.branch_id, bt.reference
UNION ALL
SELECT gen_random_uuid(), a.organization_id, a.business_id, NULL::uuid, 'warning', 'account_current_balance_drift',
  'Stored account balance differs from posted ledger balance', format('Account %s %s has stored balance %s but ledger balance %s.', a.code, a.name, COALESCE(a.current_balance,0), COALESCE(lb.ledger_balance,0)),
  'account', a.id, a.code, jsonb_build_object('stored_balance', COALESCE(a.current_balance,0), 'ledger_balance', COALESCE(lb.ledger_balance,0), 'drift', COALESCE(a.current_balance,0) - COALESCE(lb.ledger_balance,0)), now()
FROM public.accounts a LEFT JOIN ledger_balances lb ON lb.account_id = a.id
WHERE ABS(COALESCE(a.current_balance,0) - COALESCE(lb.ledger_balance,0)) > 0.01;

GRANT SELECT ON public.accounting_integrity_findings TO authenticated;

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
SELECT gen_random_uuid(), inv.organization_id, inv.business_id, inv.branch_id,
  'critical', 'posted_invoice_missing_journal_entry',
  'Posted invoice has no linked posted journal entry',
  format('Invoice %s is %s but has no linked posted journal entry.', inv.invoice_number, inv.status),
  'invoice', inv.id, inv.invoice_number,
  jsonb_build_object('invoice_status', inv.status, 'journal_entry_id', inv.journal_entry_id, 'journal_status', je.status), now()
FROM public.invoices inv
LEFT JOIN public.journal_entries je ON je.id = inv.journal_entry_id
WHERE inv.status::text NOT IN ('draft','cancelled','voided','void')
  AND (inv.journal_entry_id IS NULL OR je.status IS DISTINCT FROM 'posted')
UNION ALL
SELECT gen_random_uuid(), b.organization_id, b.business_id, b.branch_id,
  'critical', 'posted_bill_missing_journal_entry',
  'Posted bill has no linked posted journal entry',
  format('Bill %s is %s but has no linked posted journal entry.', b.bill_number, b.status),
  'bill', b.id, b.bill_number,
  jsonb_build_object('bill_status', b.status, 'journal_entry_id', b.journal_entry_id, 'journal_status', je.status), now()
FROM public.bills b
LEFT JOIN public.journal_entries je ON je.id = b.journal_entry_id
WHERE b.status::text NOT IN ('draft','void','voided','cancelled')
  AND (b.journal_entry_id IS NULL OR je.status IS DISTINCT FROM 'posted')
UNION ALL
SELECT gen_random_uuid(), p.organization_id, p.business_id, NULL::uuid,
  'critical', 'customer_payment_missing_posted_journal_entry',
  'Customer payment is applied without a posted journal entry',
  format('Payment %s is applied but has no linked posted journal entry.', COALESCE(p.receipt_number, p.id::text)),
  'payment', p.id, COALESCE(p.receipt_number, p.id::text),
  jsonb_build_object('contact_id', p.contact_id, 'amount', p.amount, 'journal_entry_id', p.journal_entry_id, 'journal_status', je.status), now()
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
  jsonb_build_object('amount', bp.amount, 'payment_date', bp.payment_date, 'journal_entry_id', bp.journal_entry_id, 'journal_status', je.status), now()
FROM public.bill_payments bp
LEFT JOIN public.journal_entries je ON je.id = bp.journal_entry_id
WHERE bp.journal_entry_id IS NULL OR je.status IS DISTINCT FROM 'posted'
UNION ALL
SELECT gen_random_uuid(), je.organization_id, je.business_id, je.branch_id,
  'critical', 'source_posting_duplicate_canonical_alias',
  'Multiple non-voided journal entries exist for the same canonical source',
  format('Source %s/%s has duplicate non-voided postings.', public.normalize_journal_source_type(je.source_type), je.source_id),
  'journal_entry', je.id, je.entry_number,
  jsonb_build_object('source_type', je.source_type, 'source_id', je.source_id, 'source_subtype', je.source_subtype), now()
FROM public.journal_entries je
WHERE je.source_id IS NOT NULL
  AND je.status <> 'voided'
  AND EXISTS (
    SELECT 1
    FROM public.journal_entries other
    WHERE other.id <> je.id
      AND other.organization_id = je.organization_id
      AND public.normalize_journal_source_type(other.source_type) = public.normalize_journal_source_type(je.source_type)
      AND other.source_id = je.source_id
      AND COALESCE(other.source_subtype, 'main') = COALESCE(je.source_subtype, 'main')
      AND other.status <> 'voided'
  )
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
