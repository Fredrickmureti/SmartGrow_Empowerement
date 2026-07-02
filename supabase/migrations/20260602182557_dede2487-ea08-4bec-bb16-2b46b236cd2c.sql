
-- ============================================================================
-- Single AR balance engine — Batch 1
-- Anchor: AR control account in the GL is the canonical source of customer
-- balance. The Sales "Customer Ledger" and Finance "Partner Ledger" both
-- read the same physical truth (ar_subledger_entries) from now on.
-- ============================================================================

-- 1. Helper: is this account an AR control account?
CREATE OR REPLACE FUNCTION public.is_ar_control_account(_account_id uuid)
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
       AND a.system_role = 'accounts_receivable'
  )
$$;

GRANT EXECUTE ON FUNCTION public.is_ar_control_account(uuid) TO authenticated, service_role;

-- 2. Canonical AR subledger view — derived directly from the GL,
--    filtered to AR control accounts only. This is the single physical
--    truth for customer balance.
DROP VIEW IF EXISTS public.ar_subledger_entries CASCADE;
CREATE VIEW public.ar_subledger_entries
WITH (security_invoker = on)
AS
  SELECT
    jel.id                                       AS line_id,
    je.id                                        AS journal_entry_id,
    je.organization_id,
    je.business_id,
    COALESCE(jel.branch_id, je.branch_id)        AS branch_id,
    jel.contact_id,
    je.entry_date,
    je.entry_number,
    je.description                               AS entry_description,
    jel.description                              AS line_description,
    COALESCE(jel.debit, 0)::numeric              AS debit,
    COALESCE(jel.credit, 0)::numeric             AS credit,
    je.source_type,
    je.source_id,
    je.currency,
    jel.created_at
    FROM public.journal_entry_lines jel
    JOIN public.journal_entries     je  ON je.id = jel.journal_entry_id
   WHERE je.status = 'posted'
     AND public.is_ar_control_account(jel.account_id);

GRANT SELECT ON public.ar_subledger_entries TO authenticated, service_role;

COMMENT ON VIEW public.ar_subledger_entries IS
  'Canonical AR subledger. Single source of truth for customer balance, '
  'derived from posted journal_entry_lines hitting AR control accounts. '
  'Both Sales Customer Ledger and Finance Partner Ledger read this view. '
  'See docs/adr/0029-single-ar-balance-engine.md.';

-- 3. Rewrite customer_ledger_entries as a thin display view over
--    ar_subledger_entries. The legacy 5-way UNION over source tables
--    is replaced by GL-derived rows, joined back to source tables
--    only for display labels (doc_type, doc_ref).
DROP VIEW IF EXISTS public.customer_ledger_entries CASCADE;
CREATE VIEW public.customer_ledger_entries
WITH (security_invoker = on)
AS
  SELECT
    s.organization_id,
    s.business_id,
    s.branch_id,
    s.contact_id,
    s.entry_date,
    -- Map GL source_type to the doc_type vocabulary used by the UI.
    CASE
      WHEN s.source_type = 'invoice'           THEN 'invoice'
      WHEN s.source_type = 'credit_note'       THEN 'credit_note'
      WHEN s.source_type = 'customer_refund'   THEN 'refund'
      WHEN s.source_type = 'refund'            THEN 'refund'
      WHEN s.source_type = 'payment'           AND s.credit > 0 THEN 'payment'
      WHEN s.source_type = 'customer_payment'  AND s.credit > 0 THEN 'payment'
      WHEN s.source_type IN ('payment','customer_payment') AND s.debit  > 0 THEN 'payment_reversal'
      ELSE COALESCE(s.source_type, 'journal')
    END                                         AS doc_type,
    COALESCE(s.source_id, s.journal_entry_id)   AS doc_id,
    -- Best-effort display reference: invoice/payment/credit-note number,
    -- else the JE number.
    COALESCE(
      i.invoice_number,
      p.receipt_number,
      cn.credit_note_number,
      s.entry_number
    )                                           AS doc_ref,
    s.debit,
    s.credit,
    s.currency,
    s.created_at,
    s.journal_entry_id
    FROM public.ar_subledger_entries s
    LEFT JOIN public.invoices      i  ON i.id  = s.source_id AND s.source_type = 'invoice'
    LEFT JOIN public.payments      p  ON p.id  = s.source_id AND s.source_type IN ('payment','customer_payment')
    LEFT JOIN public.credit_notes  cn ON cn.id = s.source_id AND s.source_type = 'credit_note';

GRANT SELECT ON public.customer_ledger_entries TO authenticated, service_role;

COMMENT ON VIEW public.customer_ledger_entries IS
  'Display projection of ar_subledger_entries with doc_type / doc_ref '
  'labels joined from source tables. ADR 0029: GL is the source of truth.';
