
CREATE OR REPLACE VIEW public.v_payroll_payment_reconciliation
WITH (security_invoker = true)
AS
WITH item_rollup AS (
  SELECT batch_id,
         count(*)                                                AS items_total,
         count(*) FILTER (WHERE item_status='paid')              AS items_paid,
         count(*) FILTER (WHERE item_status='failed')            AS items_failed,
         count(*) FILTER (WHERE item_status='pending')           AS items_pending,
         count(*) FILTER (WHERE item_status='held')              AS items_held,
         count(*) FILTER (WHERE item_status='cancelled')         AS items_cancelled,
         count(*) FILTER (WHERE item_status='reversed')          AS items_reversed,
         coalesce(sum(amount)            FILTER (WHERE item_status='paid'),    0) AS amount_paid,
         coalesce(sum(amount)            FILTER (WHERE item_status='failed'),  0) AS amount_failed,
         coalesce(sum(amount)            FILTER (WHERE item_status='pending'), 0) AS amount_pending
    FROM public.payroll_payment_batch_items
   GROUP BY batch_id
),
file_active AS (
  SELECT DISTINCT ON (batch_id)
         batch_id, id AS file_id, format_code, status AS file_status,
         transmitted_at, acknowledged_at, acknowledgement_reference,
         rejected_at, rejection_reason
    FROM public.payroll_bank_export_files
   ORDER BY batch_id, generated_at DESC
),
recon_match AS (
  SELECT DISTINCT ON (m.matched_journal_entry_id)
         m.matched_journal_entry_id AS journal_entry_id,
         m.id                       AS match_id,
         m.bank_transaction_id,
         m.status                   AS match_status,
         m.matched_amount,
         m.confirmed_at             AS match_confirmed_at,
         bt.transaction_date        AS bank_txn_date,
         bt.reference               AS bank_txn_reference
    FROM public.bank_reconciliation_matches m
    LEFT JOIN public.bank_transactions bt ON bt.id = m.bank_transaction_id
   WHERE m.matched_journal_entry_id IS NOT NULL
   ORDER BY m.matched_journal_entry_id, m.created_at DESC
)
SELECT
  b.id                            AS batch_id,
  b.organization_id,
  b.business_id,
  b.batch_number,
  b.payroll_run_id,
  b.bank_account_id,
  b.status                        AS batch_status,
  b.total_amount,
  b.payment_date,
  b.payment_journal_entry_id,
  b.reversal_je_id,
  b.reversed_at,
  b.reversal_reason,
  je.entry_number                 AS journal_entry_number,
  je.entry_date                   AS journal_entry_date,
  je.status                       AS journal_entry_status,
  COALESCE(ir.items_total, 0)     AS items_total,
  COALESCE(ir.items_paid, 0)      AS items_paid,
  COALESCE(ir.items_failed, 0)    AS items_failed,
  COALESCE(ir.items_pending, 0)   AS items_pending,
  COALESCE(ir.items_held, 0)      AS items_held,
  COALESCE(ir.items_cancelled, 0) AS items_cancelled,
  COALESCE(ir.items_reversed, 0)  AS items_reversed,
  COALESCE(ir.amount_paid, 0)     AS amount_paid,
  COALESCE(ir.amount_failed, 0)   AS amount_failed,
  COALESCE(ir.amount_pending, 0)  AS amount_pending,
  fa.file_id                      AS bank_export_file_id,
  fa.format_code                  AS bank_export_format,
  fa.file_status                  AS bank_export_status,
  fa.transmitted_at               AS bank_export_transmitted_at,
  fa.acknowledged_at              AS bank_export_acknowledged_at,
  fa.acknowledgement_reference    AS bank_export_ack_reference,
  fa.rejection_reason             AS bank_export_rejection_reason,
  rm.match_id                     AS recon_match_id,
  rm.bank_transaction_id          AS recon_bank_transaction_id,
  rm.match_status                 AS recon_match_status,
  rm.match_confirmed_at           AS recon_confirmed_at,
  rm.bank_txn_date                AS recon_bank_txn_date,
  rm.bank_txn_reference           AS recon_bank_txn_reference,
  CASE
    WHEN b.status = 'reversed'                                  THEN 'reversed'
    WHEN b.status = 'cancelled'                                 THEN 'cancelled'
    WHEN b.payment_journal_entry_id IS NULL                     THEN 'unposted'
    WHEN rm.match_id IS NULL                                    THEN 'posted_unmatched'
    WHEN rm.match_status = 'confirmed'                          THEN 'confirmed'
    ELSE 'matched_unconfirmed'
  END                              AS reconciliation_state
FROM public.payroll_payment_batches b
LEFT JOIN public.journal_entries  je ON je.id = b.payment_journal_entry_id
LEFT JOIN item_rollup             ir ON ir.batch_id = b.id
LEFT JOIN file_active             fa ON fa.batch_id = b.id
LEFT JOIN recon_match             rm ON rm.journal_entry_id = b.payment_journal_entry_id;

GRANT SELECT ON public.v_payroll_payment_reconciliation TO authenticated;
GRANT SELECT ON public.v_payroll_payment_reconciliation TO service_role;
