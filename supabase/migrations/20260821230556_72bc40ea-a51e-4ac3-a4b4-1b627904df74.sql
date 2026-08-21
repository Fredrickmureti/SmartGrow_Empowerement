-- ADR 0136: absence propagates. If ANY open item in a currency has no base
-- equivalent (no rate on file), the base-currency column for that row is NULL
-- rather than a partial sum that reads as a complete figure.
CREATE OR REPLACE VIEW public.finance_ar_net_position_by_currency AS
 WITH items AS (
         SELECT o.organization_id,
            o.business_id,
            o.branch_id,
            o.contact_id,
            o.currency,
            o.residual_amount AS amt,
            o.base_residual_amount AS base_amt,
            finance_aging_bucket(o.due_date, CURRENT_DATE) AS bucket,
            GREATEST(0, CURRENT_DATE - COALESCE(o.due_date, o.document_date)) AS days_overdue
           FROM finance_ar_open_items o
          WHERE o.residual_amount > 0.01 AND o.document_date <= CURRENT_DATE
        ), agg AS (
         SELECT items.organization_id,
            items.business_id,
            items.branch_id,
            items.contact_id,
            items.currency,
            count(*)::integer AS open_document_count,
            count(*) FILTER (WHERE items.base_amt IS NULL)::integer AS unconvertible_document_count,
            COALESCE(sum(items.amt), 0::numeric)::numeric(14,2) AS open_amount,
            (CASE
               WHEN count(*) FILTER (WHERE items.base_amt IS NULL) > 0 THEN NULL::numeric
               ELSE COALESCE(sum(items.base_amt), 0::numeric)
             END)::numeric(14,2) AS base_open_amount,
            COALESCE(sum(items.amt) FILTER (WHERE items.bucket = 'not_due'::text), 0::numeric)::numeric(14,2) AS not_due,
            COALESCE(sum(items.amt) FILTER (WHERE items.bucket = 'current'::text), 0::numeric)::numeric(14,2) AS current_bucket,
            COALESCE(sum(items.amt) FILTER (WHERE items.bucket = 'days30'::text), 0::numeric)::numeric(14,2) AS days30,
            COALESCE(sum(items.amt) FILTER (WHERE items.bucket = 'days60'::text), 0::numeric)::numeric(14,2) AS days60,
            COALESCE(sum(items.amt) FILTER (WHERE items.bucket = 'days90'::text), 0::numeric)::numeric(14,2) AS days90,
            COALESCE(max(items.days_overdue), 0) AS max_days_overdue
           FROM items
          GROUP BY items.organization_id, items.business_id, items.branch_id, items.contact_id, items.currency
        ), credit AS (
         SELECT finance_ar_customer_credit.organization_id,
            finance_ar_customer_credit.business_id,
            finance_ar_customer_credit.contact_id,
            finance_ar_customer_credit.currency,
            finance_ar_customer_credit.credit_amount,
            finance_ar_customer_credit.base_credit_amount
           FROM finance_ar_customer_credit
        )
 SELECT a.organization_id,
    a.business_id,
    a.branch_id,
    a.contact_id,
    c.name AS contact_name,
    a.currency,
    a.open_document_count,
    a.open_amount,
    COALESCE(cr.credit_amount, 0::numeric)::numeric(14,2) AS credit_amount,
    (a.open_amount - COALESCE(cr.credit_amount, 0::numeric))::numeric(14,2) AS net_amount,
    a.base_open_amount,
    (CASE WHEN cr.contact_id IS NULL THEN 0::numeric ELSE cr.base_credit_amount END)::numeric(14,2) AS base_credit_amount,
    (a.base_open_amount - (CASE WHEN cr.contact_id IS NULL THEN 0::numeric ELSE cr.base_credit_amount END))::numeric(14,2) AS base_net_amount,
    a.not_due,
    a.current_bucket,
    a.days30,
    a.days60,
    a.days90,
    a.max_days_overdue,
    a.unconvertible_document_count
   FROM agg a
     LEFT JOIN credit cr ON cr.organization_id = a.organization_id AND cr.contact_id = a.contact_id AND cr.currency = a.currency AND NOT cr.business_id IS DISTINCT FROM a.business_id
     LEFT JOIN contacts c ON c.id = a.contact_id
  WHERE is_org_member(auth.uid(), a.organization_id);