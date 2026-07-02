
-- Drop dependents first so we can reorder columns in ar_subledger_entries.
DROP VIEW IF EXISTS public.customer_ledger_entries CASCADE;
DROP VIEW IF EXISTS public.vendor_ledger_entries CASCADE;
DROP VIEW IF EXISTS public.ar_subledger_entries CASCADE;

-- 1. AR subledger (extended with account_id).
CREATE VIEW public.ar_subledger_entries
WITH (security_invoker = on) AS
SELECT
  jel.id AS line_id,
  je.id AS journal_entry_id,
  je.organization_id,
  je.business_id,
  COALESCE(jel.branch_id, je.branch_id) AS branch_id,
  jel.contact_id,
  jel.account_id,
  je.entry_date,
  je.entry_number,
  je.description AS entry_description,
  jel.description AS line_description,
  COALESCE(jel.debit, 0::numeric)  AS debit,
  COALESCE(jel.credit, 0::numeric) AS credit,
  je.source_type,
  je.source_id,
  je.currency,
  jel.created_at
FROM public.journal_entry_lines jel
JOIN public.journal_entries je ON je.id = jel.journal_entry_id
WHERE je.status = 'posted'
  AND public.is_ar_control_account(jel.account_id);

GRANT SELECT ON public.ar_subledger_entries TO authenticated, service_role;

-- 2. AP control account predicate.
CREATE OR REPLACE FUNCTION public.is_ap_control_account(_account_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.accounts a
    WHERE a.id = _account_id
      AND a.system_role = 'accounts_payable'
  );
$$;

-- 3. AP subledger view (mirror of AR).
CREATE VIEW public.ap_subledger_entries
WITH (security_invoker = on) AS
SELECT
  jel.id AS line_id,
  je.id AS journal_entry_id,
  je.organization_id,
  je.business_id,
  COALESCE(jel.branch_id, je.branch_id) AS branch_id,
  jel.contact_id,
  jel.account_id,
  je.entry_date,
  je.entry_number,
  je.description AS entry_description,
  jel.description AS line_description,
  COALESCE(jel.debit, 0::numeric)  AS debit,
  COALESCE(jel.credit, 0::numeric) AS credit,
  je.source_type,
  je.source_id,
  je.currency,
  jel.created_at
FROM public.journal_entry_lines jel
JOIN public.journal_entries je ON je.id = jel.journal_entry_id
WHERE je.status = 'posted'
  AND public.is_ap_control_account(jel.account_id);

GRANT SELECT ON public.ap_subledger_entries TO authenticated, service_role;

-- 4. Restore customer_ledger_entries on top of the extended AR subledger.
CREATE VIEW public.customer_ledger_entries
WITH (security_invoker = on) AS
SELECT
  s.organization_id,
  s.business_id,
  s.branch_id,
  s.contact_id,
  s.entry_date,
  CASE
    WHEN s.source_type = 'invoice'         THEN 'invoice'
    WHEN s.source_type = 'credit_note'     THEN 'credit_note'
    WHEN s.source_type = 'customer_refund' THEN 'refund'
    WHEN s.source_type = 'refund'          THEN 'refund'
    WHEN s.source_type = 'payment'          AND s.credit > 0 THEN 'payment'
    WHEN s.source_type = 'customer_payment' AND s.credit > 0 THEN 'payment'
    WHEN s.source_type IN ('payment','customer_payment') AND s.debit > 0 THEN 'payment_reversal'
    ELSE COALESCE(s.source_type, 'journal')
  END AS doc_type,
  COALESCE(s.source_id, s.journal_entry_id) AS doc_id,
  COALESCE(i.invoice_number, p.receipt_number, cn.credit_note_number, s.entry_number) AS doc_ref,
  s.debit,
  s.credit,
  s.currency,
  s.created_at,
  s.journal_entry_id
FROM public.ar_subledger_entries s
LEFT JOIN public.invoices     i  ON i.id  = s.source_id AND s.source_type = 'invoice'
LEFT JOIN public.payments     p  ON p.id  = s.source_id AND s.source_type IN ('payment','customer_payment')
LEFT JOIN public.credit_notes cn ON cn.id = s.source_id AND s.source_type = 'credit_note';

GRANT SELECT ON public.customer_ledger_entries TO authenticated, service_role;

-- 5. Rebuild vendor_ledger_entries on top of the AP subledger.
CREATE VIEW public.vendor_ledger_entries
WITH (security_invoker = on) AS
SELECT
  s.organization_id,
  s.business_id,
  s.branch_id,
  s.contact_id,
  s.entry_date,
  CASE
    WHEN s.source_type = 'bill'               THEN 'bill'
    WHEN s.source_type = 'bill_payment'       THEN 'bill_payment'
    WHEN s.source_type = 'vendor_credit_note' THEN 'vendor_credit_note'
    WHEN s.source_type IN ('bill_payment') AND s.credit > 0 THEN 'payment_reversal'
    ELSE COALESCE(s.source_type, 'journal')
  END AS doc_type,
  COALESCE(s.source_id, s.journal_entry_id) AS doc_id,
  COALESCE(b.bill_number, bp.reference, vcn.credit_note_number, s.entry_number) AS doc_ref,
  s.debit,
  s.credit,
  s.currency,
  s.created_at
FROM public.ap_subledger_entries s
LEFT JOIN public.bills               b   ON b.id   = s.source_id AND s.source_type = 'bill'
LEFT JOIN public.bill_payments       bp  ON bp.id  = s.source_id AND s.source_type = 'bill_payment'
LEFT JOIN public.vendor_credit_notes vcn ON vcn.id = s.source_id AND s.source_type = 'vendor_credit_note';

GRANT SELECT ON public.vendor_ledger_entries TO authenticated, service_role;

-- 6. Control tie-out: GL control-account balance vs subledger sum, per org/account.
CREATE OR REPLACE VIEW public.control_account_tieout
WITH (security_invoker = on) AS
WITH gl AS (
  SELECT
    je.organization_id,
    jel.account_id,
    SUM(COALESCE(jel.debit, 0) - COALESCE(jel.credit, 0)) AS gl_balance
  FROM public.journal_entry_lines jel
  JOIN public.journal_entries je ON je.id = jel.journal_entry_id
  WHERE je.status = 'posted'
    AND (public.is_ar_control_account(jel.account_id)
      OR public.is_ap_control_account(jel.account_id))
  GROUP BY je.organization_id, jel.account_id
),
sub AS (
  SELECT organization_id, account_id, SUM(debit - credit) AS sub_balance
  FROM public.ar_subledger_entries
  GROUP BY organization_id, account_id
  UNION ALL
  SELECT organization_id, account_id, SUM(debit - credit) AS sub_balance
  FROM public.ap_subledger_entries
  GROUP BY organization_id, account_id
)
SELECT
  gl.organization_id,
  gl.account_id,
  a.code        AS account_code,
  a.name        AS account_name,
  a.system_role,
  gl.gl_balance,
  COALESCE(s.sub_balance, 0) AS subledger_balance,
  gl.gl_balance - COALESCE(s.sub_balance, 0) AS drift
FROM gl
JOIN public.accounts a ON a.id = gl.account_id
LEFT JOIN sub s ON s.organization_id = gl.organization_id AND s.account_id = gl.account_id;

GRANT SELECT ON public.control_account_tieout TO authenticated, service_role;
