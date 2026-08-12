CREATE OR REPLACE VIEW public.reversal_register
WITH (security_invoker = true) AS
WITH base AS (
  SELECT i.organization_id, i.business_id, i.branch_id,
         'sales'::text AS module, 'invoice'::text AS document_type,
         i.id AS document_id, i.invoice_number AS document_number,
         i.issue_date AS document_date, i.voided_at AS reversal_date,
         i.total AS amount, i.currency,
         i.void_reason_code AS reason_code, i.void_reason AS reason_comment,
         i.voided_by AS reversed_by, 'void'::text AS reversal_kind,
         'reversal.invoice'::text AS action_key
    FROM public.invoices i WHERE i.voided_at IS NOT NULL
  UNION ALL
  SELECT p.organization_id, p.business_id, p.branch_id,
         'sales', 'payment', p.id, p.receipt_number, p.payment_date, p.voided_at,
         p.amount, NULL::text, p.void_reason_code, p.void_reason, p.voided_by,
         'void', 'reversal.payment'
    FROM public.payments p WHERE p.voided_at IS NOT NULL
  UNION ALL
  SELECT r.organization_id, r.business_id, r.branch_id,
         'sales', 'customer_refund', r.id, r.reference, r.refund_date, r.voided_at,
         r.amount, r.currency, NULL::text, COALESCE(r.void_reason, r.reason), r.voided_by,
         'void', 'reversal.customer_refund'
    FROM public.customer_refunds r WHERE r.voided_at IS NOT NULL
  UNION ALL
  SELECT b.organization_id, b.business_id, b.branch_id,
         'purchases', 'bill', b.id, b.bill_number, b.bill_date, b.voided_at,
         b.total, b.currency, b.void_reason_code, b.void_reason, b.voided_by,
         'void', 'reversal.bill'
    FROM public.bills b WHERE b.voided_at IS NOT NULL
  UNION ALL
  SELECT bp.organization_id, bp.business_id, bp.branch_id,
         'purchases', 'bill_payment', bp.id, bp.reference, bp.payment_date, bp.voided_at,
         bp.amount, NULL::text, bp.void_reason_code, bp.void_reason, bp.voided_by,
         'void', 'reversal.bill_payment'
    FROM public.bill_payments bp WHERE bp.voided_at IS NOT NULL
  UNION ALL
  SELECT e.organization_id, e.business_id, e.branch_id,
         'purchases', 'expense', e.id, e.expense_number, e.expense_date, e.voided_at,
         e.amount, e.currency, e.void_reason_code, e.void_reason, e.voided_by,
         'void', 'reversal.expense'
    FROM public.expenses e WHERE e.voided_at IS NOT NULL
  UNION ALL
  -- ADR 0132 Phase 4 — a reversed vendor credit note is a business reversal and
  -- must be visible in the period register next to voided bills and payments.
  SELECT vcn.organization_id, vcn.business_id, vcn.branch_id,
         'purchases', 'vendor_credit_note', vcn.id, vcn.credit_note_number,
         vcn.credit_date, vcn.reversed_at, vcn.total, vcn.currency,
         vcn.reversal_reason_code, vcn.reversal_reason, vcn.reversed_by,
         'reversal', 'reversal.vendor_credit_note'
    FROM public.vendor_credit_notes vcn WHERE vcn.reversed_at IS NOT NULL
  UNION ALL
  SELECT gr.organization_id, gr.business_id, gr.branch_id,
         'receiving', 'goods_receipt', gr.id, gr.receipt_number, gr.receipt_date,
         gr.updated_at, NULL::numeric, NULL::text, gr.reversal_reason_code, NULL::text,
         NULL::uuid, 'reversal', 'reversal.goods_receipt'
    FROM public.goods_receipts gr WHERE gr.status = 'reversed'::text
  UNION ALL
  SELECT pt.organization_id, pt.business_id, pt.branch_id,
         'pos', 'pos_transaction', pt.id, pt.transaction_number,
         pt.completed_at::date, pt.voided_at, pt.total, NULL::text, NULL::text,
         COALESCE(pt.void_note, pt.void_reason), pt.voided_by,
         COALESCE(pt.reversal_type::text, 'void'::text), 'reversal.pos_transaction'
    FROM public.pos_transactions pt WHERE pt.voided_at IS NOT NULL
  UNION ALL
  SELECT pr.organization_id, pr.business_id, pr.branch_id,
         'payroll', 'payroll_run', pr.id, pr.payroll_number, pr.payment_date,
         pr.reversed_at, pr.total_net, pr.currency, NULL::text, pr.reversal_reason,
         pr.reversed_by, 'correction', 'reversal.payroll_run'
    FROM public.payroll_runs pr WHERE pr.reversed_at IS NOT NULL
)
SELECT base.organization_id, base.business_id, base.branch_id, base.module,
       base.document_type, base.document_id, base.document_number, base.document_date,
       base.reversal_date, base.amount, base.currency, base.reason_code,
       base.reason_comment, base.reversed_by, base.reversal_kind, base.action_key,
       ar.id AS approval_request_id, ar.status AS approval_status
  FROM base
  LEFT JOIN LATERAL (
    SELECT a.id, a.status FROM public.approval_requests a
     WHERE a.entity_id = base.document_id AND a.action_key = base.action_key
     ORDER BY a.created_at DESC LIMIT 1) ar ON true;

GRANT SELECT ON public.reversal_register TO authenticated;

NOTIFY pgrst, 'reload schema';