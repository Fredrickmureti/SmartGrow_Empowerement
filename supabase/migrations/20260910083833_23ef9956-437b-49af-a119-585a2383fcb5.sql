CREATE OR REPLACE VIEW public.reversal_register AS
 WITH base AS (
         SELECT b.organization_id,
            d.business_id,
            l.branch_id,
            'lending'::text AS module,
            'loan_disbursement'::text AS document_type,
            d.id AS document_id,
            l.loan_number AS document_number,
            d.disbursed_on AS document_date,
            d.reversed_at AS reversal_date,
            d.amount,
            l.currency_code AS currency,
            NULL::text AS reason_code,
            d.reversal_reason AS reason_comment,
            d.reversed_by,
            'reversal'::text AS reversal_kind,
            'reversal.loan_disbursement'::text AS action_key
           FROM mf_loan_disbursements d
             JOIN mf_loans l ON l.id = d.loan_id
             JOIN businesses b ON b.id = d.business_id
          WHERE d.reversed_at IS NOT NULL
        UNION ALL
         SELECT b.organization_id,
            r.business_id,
            r.branch_id,
            'collections'::text,
            'loan_repayment'::text,
            r.id,
            r.receipt_number,
            r.paid_on,
            r.reversed_at,
            r.amount,
            l.currency_code,
            NULL::text,
            r.reversal_reason,
            r.reversed_by,
            'reversal'::text,
            'reversal.loan_repayment'::text
           FROM mf_repayments r
             JOIN mf_loans l ON l.id = r.loan_id
             JOIN businesses b ON b.id = r.business_id
          WHERE r.reversed_at IS NOT NULL
        UNION ALL
         SELECT e.organization_id,
            e.business_id,
            e.branch_id,
            'expenses'::text,
            'expense'::text,
            e.id,
            e.expense_number,
            e.expense_date,
            e.voided_at,
            e.amount::numeric(18,2),
            e.currency,
            e.void_reason_code,
            e.void_reason,
            e.voided_by,
            'void'::text,
            'reversal.expense'::text
           FROM expenses e
          WHERE e.voided_at IS NOT NULL
        )
 SELECT base.organization_id,
    base.business_id,
    base.branch_id,
    base.module,
    base.document_type,
    base.document_id,
    base.document_number,
    base.document_date,
    base.reversal_date,
    base.amount,
    base.currency,
    base.reason_code,
    base.reason_comment,
    base.reversed_by,
    base.reversal_kind,
    base.action_key,
    ar.id AS approval_request_id,
    ar.status AS approval_status
   FROM base
     LEFT JOIN LATERAL ( SELECT a.id, a.status
           FROM approval_requests a
          WHERE a.entity_id = base.document_id AND a.action_key = base.action_key
          ORDER BY a.created_at DESC
         LIMIT 1) ar ON true;