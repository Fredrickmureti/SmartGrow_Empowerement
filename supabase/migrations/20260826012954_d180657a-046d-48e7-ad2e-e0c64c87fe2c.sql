-- =====================================================================
-- Phase 1 (D1): remove the silent 1:1 FX fallback from live reporting.
--
-- Previously these four functions used COALESCE(NULLIF(rate, 0), 1), which
-- valued a foreign document with a missing or zero stamped rate at face value
-- (USD 1,000 counted as KES 1,000). Two of them are the sub-ledger-to-GL
-- reconciliations, so the report that exists to detect FX drift was the one
-- concealing it.
--
-- New rule: a document converts only on evidence. It uses its stamped rate,
-- or 1 when it is genuinely denominated in the business base currency, and is
-- otherwise reported as UNCONVERTIBLE and excluded from the measures.
--
-- No posted amount, stamped rate, or GL balance is touched.
-- =====================================================================

CREATE OR REPLACE FUNCTION public.fx_report_document_rate(
  p_document_currency text,
  p_stamped_rate      numeric,
  p_base_currency     text
)
RETURNS numeric
LANGUAGE sql
IMMUTABLE
SET search_path TO 'public'
AS $function$
  -- Reporting-side conversion evidence. Never invents a rate:
  --   stamped rate > 0                      -> the historical measurement
  --   document currency IS the base unit    -> identity (1)
  --   anything else                         -> NULL (unconvertible)
  SELECT CASE
    WHEN p_stamped_rate IS NOT NULL AND p_stamped_rate > 0 THEN p_stamped_rate
    WHEN p_base_currency IS NOT NULL
         AND upper(COALESCE(NULLIF(btrim(p_document_currency), ''), p_base_currency))
             = upper(btrim(p_base_currency)) THEN 1::numeric
    ELSE NULL::numeric
  END
$function$;

COMMENT ON FUNCTION public.fx_report_document_rate(text, numeric, text) IS
  'Reporting conversion evidence for a document: stamped rate, identity when the document is in the base currency, else NULL (unconvertible). Never returns an invented 1:1 for a foreign document.';

GRANT EXECUTE ON FUNCTION public.fx_report_document_rate(text, numeric, text) TO authenticated, service_role;

-- ---------------------------------------------------------------------
-- finance_sales_analysis
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.finance_sales_analysis(_org_id uuid, _from date, _to date, _business_id uuid DEFAULT NULL::uuid, _branch_id uuid DEFAULT NULL::uuid, _dimension text DEFAULT 'customer'::text, _limit integer DEFAULT NULL::integer, _offset integer DEFAULT 0)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_result jsonb;
BEGIN
  IF NOT public.finance_can_read_org(_org_id) THEN
    RAISE EXCEPTION 'forbidden: not a member of this organization' USING ERRCODE = '42501';
  END IF;
  IF _from IS NULL OR _to IS NULL THEN
    RAISE EXCEPTION 'from and to dates are required' USING ERRCODE = '22023';
  END IF;
  IF _dimension NOT IN ('customer','product','category','branch','salesperson','month') THEN
    RAISE EXCEPTION 'unsupported sales dimension: %', _dimension USING ERRCODE = '22023';
  END IF;

  WITH inv AS (
    SELECT i.id, i.contact_id, i.branch_id, i.salesperson_id, i.issue_date,
           public.fx_report_document_rate(i.currency, i.exchange_rate, biz.base_currency) AS rate
    FROM public.invoices i
    LEFT JOIN public.businesses biz ON biz.id = i.business_id
    WHERE i.organization_id = _org_id
      AND (_business_id IS NULL OR i.business_id = _business_id)
      AND (_branch_id IS NULL OR i.branch_id = _branch_id)
      AND i.issue_date BETWEEN _from AND _to
      AND i.journal_entry_id IS NOT NULL
      AND i.voided_at IS NULL
      AND i.status NOT IN ('draft','cancelled','voided')
  ), cn AS (
    SELECT c.id, c.contact_id, c.branch_id, c.issue_date,
           public.fx_report_document_rate(c.currency, c.exchange_rate, biz.base_currency) AS rate,
           si.salesperson_id
    FROM public.credit_notes c
    LEFT JOIN public.invoices si ON si.id = COALESCE(c.original_invoice_id, c.invoice_id)
    LEFT JOIN public.businesses biz ON biz.id = c.business_id
    WHERE c.organization_id = _org_id
      AND (_business_id IS NULL OR c.business_id = _business_id)
      AND (_branch_id IS NULL OR c.branch_id = _branch_id)
      AND c.issue_date BETWEEN _from AND _to
      AND c.status NOT IN ('draft','void')
  ), sale_lines AS (
    SELECT
      CASE _dimension
        WHEN 'customer'    THEN COALESCE(i.contact_id::text, 'unassigned')
        WHEN 'product'     THEN COALESCE(it.product_id::text, 'unassigned')
        WHEN 'category'    THEN COALESCE(p.category_id::text, 'unassigned')
        WHEN 'branch'      THEN COALESCE(i.branch_id::text, 'unassigned')
        WHEN 'salesperson' THEN COALESCE(i.salesperson_id::text, 'unassigned')
        ELSE to_char(i.issue_date, 'YYYY-MM')
      END AS dim_key,
      i.id AS sale_doc,
      (COALESCE(it.quantity,0) * COALESCE(it.unit_price,0) * i.rate)::numeric AS gross,
      (COALESCE(it.quantity,0) * COALESCE(it.unit_price,0)
        * COALESCE(it.discount_percent,0) / 100.0 * i.rate)::numeric AS discount,
      (COALESCE(it.tax_amount,0) * i.rate)::numeric AS tax,
      COALESCE(it.quantity,0)::numeric AS qty
    FROM inv i
    JOIN public.invoice_items it ON it.invoice_id = i.id
    LEFT JOIN public.products p ON p.id = it.product_id
    WHERE i.rate IS NOT NULL
  ), return_lines AS (
    SELECT
      CASE _dimension
        WHEN 'customer'    THEN COALESCE(c.contact_id::text, 'unassigned')
        WHEN 'product'     THEN COALESCE(ci.product_id::text, 'unassigned')
        WHEN 'category'    THEN COALESCE(p.category_id::text, 'unassigned')
        WHEN 'branch'      THEN COALESCE(c.branch_id::text, 'unassigned')
        WHEN 'salesperson' THEN COALESCE(c.salesperson_id::text, 'unassigned')
        ELSE to_char(c.issue_date, 'YYYY-MM')
      END AS dim_key,
      c.id AS return_doc,
      (COALESCE(ci.quantity,0) * COALESCE(ci.unit_price,0) * c.rate)::numeric AS returns,
      (COALESCE(ci.tax_amount,0) * c.rate)::numeric AS returns_tax,
      COALESCE(ci.quantity,0)::numeric AS qty
    FROM cn c
    JOIN public.credit_note_items ci ON ci.credit_note_id = c.id
    LEFT JOIN public.products p ON p.id = ci.product_id
    WHERE c.rate IS NOT NULL
  ), cost_lines AS (
    SELECT
      CASE _dimension
        WHEN 'customer'    THEN COALESCE(i.contact_id::text, 'unassigned')
        WHEN 'product'     THEN COALESCE(sm.product_id::text, 'unassigned')
        WHEN 'category'    THEN COALESCE(p.category_id::text, 'unassigned')
        WHEN 'branch'      THEN COALESCE(i.branch_id::text, 'unassigned')
        WHEN 'salesperson' THEN COALESCE(i.salesperson_id::text, 'unassigned')
        ELSE to_char(i.issue_date, 'YYYY-MM')
      END AS dim_key,
      (ABS(COALESCE(sm.quantity,0)) * COALESCE(sm.unit_cost,0))::numeric AS cost
    FROM public.stock_movements sm
    JOIN inv i ON i.id = sm.reference_id
    LEFT JOIN public.products p ON p.id = sm.product_id
    WHERE sm.reference_type = 'invoice'
      AND sm.organization_id = _org_id
      AND i.rate IS NOT NULL
    UNION ALL
    SELECT
      CASE _dimension
        WHEN 'customer'    THEN COALESCE(c.contact_id::text, 'unassigned')
        WHEN 'product'     THEN COALESCE(sm.product_id::text, 'unassigned')
        WHEN 'category'    THEN COALESCE(p.category_id::text, 'unassigned')
        WHEN 'branch'      THEN COALESCE(c.branch_id::text, 'unassigned')
        WHEN 'salesperson' THEN COALESCE(c.salesperson_id::text, 'unassigned')
        ELSE to_char(c.issue_date, 'YYYY-MM')
      END AS dim_key,
      (-1 * ABS(COALESCE(sm.quantity,0)) * COALESCE(sm.unit_cost,0))::numeric AS cost
    FROM public.stock_movements sm
    JOIN cn c ON c.id = sm.reference_id
    LEFT JOIN public.products p ON p.id = sm.product_id
    WHERE sm.reference_type = 'credit_note'
      AND sm.organization_id = _org_id
      AND c.rate IS NOT NULL
  ), unioned AS (
    SELECT dim_key, gross, discount, tax, 0::numeric AS returns, 0::numeric AS returns_tax,
           0::numeric AS cost, qty, sale_doc, NULL::uuid AS return_doc
    FROM sale_lines
    UNION ALL
    SELECT dim_key, 0, 0, 0, returns, returns_tax, 0, -qty, NULL::uuid, return_doc
    FROM return_lines
    UNION ALL
    SELECT dim_key, 0, 0, 0, 0, 0, cost, 0, NULL::uuid, NULL::uuid
    FROM cost_lines
  ), agg AS (
    SELECT
      u.dim_key,
      CASE WHEN u.dim_key ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
           THEN u.dim_key::uuid END AS dim_uuid,
      ROUND(SUM(u.gross), 2)        AS gross,
      ROUND(SUM(u.discount), 2)     AS discount,
      ROUND(SUM(u.tax), 2)          AS tax,
      ROUND(SUM(u.returns), 2)      AS returns,
      ROUND(SUM(u.returns_tax), 2)  AS returns_tax,
      ROUND(SUM(u.cost), 2)         AS cost,
      SUM(u.qty)                    AS qty,
      COUNT(DISTINCT u.sale_doc)    AS sale_docs,
      COUNT(DISTINCT u.return_doc)  AS return_docs
    FROM unioned u
    GROUP BY 1, 2
  ), unconvertible AS (
    SELECT
      (SELECT COUNT(*) FROM inv WHERE rate IS NULL)::bigint AS sale_docs,
      (SELECT COUNT(*) FROM cn  WHERE rate IS NULL)::bigint AS return_docs
  ), paged AS (
    SELECT
      jsonb_build_object(
        'dimension_key',  a.dim_key,
        'dimension_id',   a.dim_uuid,
        'label', CASE _dimension
          WHEN 'customer'    THEN COALESCE(ct.name, 'Unassigned')
          WHEN 'product'     THEN COALESCE(pr.name, 'Unassigned')
          WHEN 'category'    THEN COALESCE(pc.name, 'Uncategorised')
          WHEN 'branch'      THEN COALESCE(br.name, 'Unassigned')
          WHEN 'salesperson' THEN COALESCE(pf.full_name, pf.email, 'Unassigned')
          ELSE to_char(to_date(a.dim_key || '-01', 'YYYY-MM-DD'), 'Mon YYYY')
        END,
        'gross',             a.gross,
        'discount',          a.discount,
        'net_sales',         ROUND(a.gross - a.discount, 2),
        'tax',               a.tax,
        'returns',           a.returns,
        'net_after_returns', ROUND(a.gross - a.discount - a.returns, 2),
        'cost',              a.cost,
        'margin',            ROUND(a.gross - a.discount - a.returns - a.cost, 2),
        'margin_pct', CASE
          WHEN ROUND(a.gross - a.discount - a.returns, 2) = 0 THEN NULL
          ELSE ROUND(100 * (a.gross - a.discount - a.returns - a.cost)
                     / (a.gross - a.discount - a.returns), 2)
        END,
        'quantity',          a.qty,
        'sale_documents',    a.sale_docs,
        'return_documents',  a.return_docs
      ) AS r,
      CASE WHEN _dimension = 'month' THEN a.dim_key
           ELSE lpad((1000000000 - LEAST(GREATEST(ROUND(a.gross - a.discount - a.returns), -999999999), 999999999))::text, 12, '0')
      END AS r_sort_key,
      CASE _dimension
        WHEN 'customer'    THEN COALESCE(ct.name, 'Unassigned')
        WHEN 'product'     THEN COALESCE(pr.name, 'Unassigned')
        WHEN 'category'    THEN COALESCE(pc.name, 'Uncategorised')
        WHEN 'branch'      THEN COALESCE(br.name, 'Unassigned')
        WHEN 'salesperson' THEN COALESCE(pf.full_name, pf.email, 'Unassigned')
        ELSE a.dim_key
      END AS r_label
    FROM agg a
    LEFT JOIN public.contacts ct           ON ct.id = a.dim_uuid AND _dimension = 'customer'
    LEFT JOIN public.products pr           ON pr.id = a.dim_uuid AND _dimension = 'product'
    LEFT JOIN public.product_categories pc ON pc.id = a.dim_uuid AND _dimension = 'category'
    LEFT JOIN public.branches br           ON br.id = a.dim_uuid AND _dimension = 'branch'
    LEFT JOIN public.profiles pf           ON pf.user_id = a.dim_uuid AND _dimension = 'salesperson'
    ORDER BY r_sort_key, r_label
    LIMIT CASE WHEN _limit IS NULL OR _limit <= 0 THEN NULL ELSE _limit END
    OFFSET GREATEST(COALESCE(_offset, 0), 0)
  )
  SELECT jsonb_build_object(
    'dimension', _dimension,
    'from', _from,
    'to', _to,
    'rows', (SELECT COALESCE(jsonb_agg(p.r ORDER BY p.r_sort_key, p.r_label), '[]'::jsonb) FROM paged p),
    'totals', (
      SELECT jsonb_build_object(
        'gross',             ROUND(COALESCE(SUM(gross),0), 2),
        'discount',          ROUND(COALESCE(SUM(discount),0), 2),
        'net_sales',         ROUND(COALESCE(SUM(gross - discount),0), 2),
        'tax',               ROUND(COALESCE(SUM(tax),0), 2),
        'returns',           ROUND(COALESCE(SUM(returns),0), 2),
        'net_after_returns', ROUND(COALESCE(SUM(gross - discount - returns),0), 2),
        'cost',              ROUND(COALESCE(SUM(cost),0), 2),
        'margin',            ROUND(COALESCE(SUM(gross - discount - returns - cost),0), 2),
        'quantity',          COALESCE(SUM(qty),0),
        'sale_documents',    COALESCE(SUM(sale_docs),0),
        'return_documents',  COALESCE(SUM(return_docs),0),
        'unconvertible_document_count',
          (SELECT sale_docs + return_docs FROM unconvertible)
      ) FROM agg
    ),
    'unconvertible', (
      SELECT jsonb_build_object(
        'sale_documents',   u.sale_docs,
        'return_documents', u.return_docs,
        'total',            u.sale_docs + u.return_docs
      ) FROM unconvertible u
    ),
    'paging', jsonb_build_object(
      'total_rows', (SELECT COUNT(*) FROM agg),
      'limit', _limit,
      'offset', GREATEST(COALESCE(_offset, 0), 0)
    )
  )
  INTO v_result;

  RETURN v_result;
END;
$function$;

-- ---------------------------------------------------------------------
-- finance_purchase_analysis
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.finance_purchase_analysis(_org_id uuid, _from date, _to date, _business_id uuid DEFAULT NULL::uuid, _branch_id uuid DEFAULT NULL::uuid, _dimension text DEFAULT 'supplier'::text, _limit integer DEFAULT NULL::integer, _offset integer DEFAULT 0)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_result jsonb;
BEGIN
  IF NOT public.finance_can_read_org(_org_id) THEN
    RAISE EXCEPTION 'forbidden: not a member of this organization' USING ERRCODE = '42501';
  END IF;
  IF _from IS NULL OR _to IS NULL THEN
    RAISE EXCEPTION 'from and to dates are required' USING ERRCODE = '22023';
  END IF;
  IF _dimension NOT IN ('supplier','product','category','account','branch','month') THEN
    RAISE EXCEPTION 'unsupported purchase dimension: %', _dimension USING ERRCODE = '22023';
  END IF;

  WITH bl AS (
    SELECT b.id, b.vendor_id, b.branch_id, b.bill_date,
           public.fx_report_document_rate(b.currency, b.currency_rate, biz.base_currency) AS rate,
           COALESCE(b.discount_amount, 0) AS header_discount
    FROM public.bills b
    LEFT JOIN public.businesses biz ON biz.id = b.business_id
    WHERE b.organization_id = _org_id
      AND (_business_id IS NULL OR b.business_id = _business_id)
      AND (_branch_id IS NULL OR b.branch_id = _branch_id)
      AND b.bill_date BETWEEN _from AND _to
      AND b.journal_entry_id IS NOT NULL
      AND b.voided_at IS NULL
      AND b.status NOT IN ('draft','void')
  ), vcn AS (
    SELECT c.id, c.vendor_id, c.branch_id, c.credit_date,
           public.fx_report_document_rate(c.currency, c.exchange_rate, biz.base_currency) AS rate
    FROM public.vendor_credit_notes c
    LEFT JOIN public.businesses biz ON biz.id = c.business_id
    WHERE c.organization_id = _org_id
      AND (_business_id IS NULL OR c.business_id = _business_id)
      AND (_branch_id IS NULL OR c.branch_id = _branch_id)
      AND c.credit_date BETWEEN _from AND _to
      AND c.journal_entry_id IS NOT NULL
      AND c.reversed_at IS NULL
      AND lower(COALESCE(c.status, '')) NOT IN ('draft','void','voided','cancelled','rejected')
  ), purchase_lines AS (
    SELECT
      CASE _dimension
        WHEN 'supplier' THEN COALESCE(b.vendor_id::text, 'unassigned')
        WHEN 'product'  THEN COALESCE(it.product_id::text, 'unassigned')
        WHEN 'category' THEN COALESCE(p.category_id::text, 'unassigned')
        WHEN 'account'  THEN COALESCE(it.account_id::text, 'unassigned')
        WHEN 'branch'   THEN COALESCE(b.branch_id::text, 'unassigned')
        ELSE to_char(b.bill_date, 'YYYY-MM')
      END AS dim_key,
      b.id AS purchase_doc,
      (COALESCE(it.line_total, COALESCE(it.quantity,0) * COALESCE(it.unit_price,0)) * b.rate)::numeric AS gross,
      (b.header_discount * b.rate
        * COALESCE(it.line_total, COALESCE(it.quantity,0) * COALESCE(it.unit_price,0))
        / NULLIF(SUM(COALESCE(it.line_total, COALESCE(it.quantity,0) * COALESCE(it.unit_price,0)))
                 OVER (PARTITION BY b.id), 0))::numeric AS discount,
      (COALESCE(it.tax_amount, 0) * b.rate)::numeric AS tax,
      COALESCE(it.quantity, 0)::numeric AS qty
    FROM bl b
    JOIN public.bill_items it ON it.bill_id = b.id
    LEFT JOIN public.products p ON p.id = it.product_id
    WHERE b.rate IS NOT NULL
  ), return_lines AS (
    SELECT
      CASE _dimension
        WHEN 'supplier' THEN COALESCE(c.vendor_id::text, 'unassigned')
        WHEN 'product'  THEN COALESCE(ci.product_id::text, 'unassigned')
        WHEN 'category' THEN COALESCE(p.category_id::text, 'unassigned')
        WHEN 'account'  THEN COALESCE(ci.account_id::text, 'unassigned')
        WHEN 'branch'   THEN COALESCE(c.branch_id::text, 'unassigned')
        ELSE to_char(c.credit_date, 'YYYY-MM')
      END AS dim_key,
      c.id AS return_doc,
      (COALESCE(ci.line_total, COALESCE(ci.quantity,0) * COALESCE(ci.unit_price,0)) * c.rate)::numeric AS returns,
      (COALESCE(ci.tax_amount, 0) * c.rate)::numeric AS returns_tax,
      COALESCE(ci.quantity, 0)::numeric AS qty
    FROM vcn c
    JOIN public.vendor_credit_note_items ci ON ci.credit_note_id = c.id
    LEFT JOIN public.products p ON p.id = ci.product_id
    WHERE c.rate IS NOT NULL
  ), unioned AS (
    SELECT dim_key, gross, COALESCE(discount, 0) AS discount, tax,
           0::numeric AS returns, 0::numeric AS returns_tax, qty,
           purchase_doc, NULL::uuid AS return_doc
    FROM purchase_lines
    UNION ALL
    SELECT dim_key, 0, 0, 0, returns, returns_tax, -qty, NULL::uuid, return_doc
    FROM return_lines
  ), agg AS (
    SELECT
      u.dim_key,
      CASE WHEN u.dim_key ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
           THEN u.dim_key::uuid END AS dim_uuid,
      ROUND(SUM(u.gross), 2)       AS gross,
      ROUND(SUM(u.discount), 2)    AS discount,
      ROUND(SUM(u.tax), 2)         AS tax,
      ROUND(SUM(u.returns), 2)     AS returns,
      ROUND(SUM(u.returns_tax), 2) AS returns_tax,
      SUM(u.qty)                   AS qty,
      COUNT(DISTINCT u.purchase_doc) AS purchase_docs,
      COUNT(DISTINCT u.return_doc)   AS return_docs
    FROM unioned u
    GROUP BY 1, 2
  ), unconvertible AS (
    SELECT
      (SELECT COUNT(*) FROM bl  WHERE rate IS NULL)::bigint AS purchase_docs,
      (SELECT COUNT(*) FROM vcn WHERE rate IS NULL)::bigint AS return_docs
  ), paged AS (
    SELECT
      jsonb_build_object(
        'dimension_key', a.dim_key,
        'dimension_id',  a.dim_uuid,
        'label', CASE _dimension
          WHEN 'supplier' THEN COALESCE(ct.name, 'Unassigned')
          WHEN 'product'  THEN COALESCE(pr.name, 'Unassigned')
          WHEN 'category' THEN COALESCE(pc.name, 'Uncategorised')
          WHEN 'account'  THEN COALESCE(ac.name, 'Unassigned')
          WHEN 'branch'   THEN COALESCE(br.name, 'Unassigned')
          ELSE to_char(to_date(a.dim_key || '-01', 'YYYY-MM-DD'), 'Mon YYYY')
        END,
        'gross',              a.gross,
        'discount',           a.discount,
        'net_purchases',      ROUND(a.gross - a.discount, 2),
        'tax',                a.tax,
        'returns',            a.returns,
        'net_after_returns',  ROUND(a.gross - a.discount - a.returns, 2),
        'quantity',           a.qty,
        'purchase_documents', a.purchase_docs,
        'return_documents',   a.return_docs
      ) AS r,
      CASE WHEN _dimension = 'month' THEN a.dim_key
           ELSE lpad((1000000000 - LEAST(GREATEST(ROUND(a.gross - a.discount - a.returns), -999999999), 999999999))::text, 12, '0')
      END AS r_sort_key,
      CASE _dimension
        WHEN 'supplier' THEN COALESCE(ct.name, 'Unassigned')
        WHEN 'product'  THEN COALESCE(pr.name, 'Unassigned')
        WHEN 'category' THEN COALESCE(pc.name, 'Uncategorised')
        WHEN 'account'  THEN COALESCE(ac.name, 'Unassigned')
        WHEN 'branch'   THEN COALESCE(br.name, 'Unassigned')
        ELSE a.dim_key
      END AS r_label
    FROM agg a
    LEFT JOIN public.contacts ct           ON ct.id = a.dim_uuid AND _dimension = 'supplier'
    LEFT JOIN public.products pr           ON pr.id = a.dim_uuid AND _dimension = 'product'
    LEFT JOIN public.product_categories pc ON pc.id = a.dim_uuid AND _dimension = 'category'
    LEFT JOIN public.accounts ac           ON ac.id = a.dim_uuid AND _dimension = 'account'
    LEFT JOIN public.branches br           ON br.id = a.dim_uuid AND _dimension = 'branch'
    ORDER BY r_sort_key, r_label
    LIMIT CASE WHEN _limit IS NULL OR _limit <= 0 THEN NULL ELSE _limit END
    OFFSET GREATEST(COALESCE(_offset, 0), 0)
  )
  SELECT jsonb_build_object(
    'dimension', _dimension,
    'from', _from,
    'to', _to,
    'rows', (SELECT COALESCE(jsonb_agg(p.r ORDER BY p.r_sort_key, p.r_label), '[]'::jsonb) FROM paged p),
    'totals', (
      SELECT jsonb_build_object(
        'gross',              ROUND(COALESCE(SUM(gross),0), 2),
        'discount',           ROUND(COALESCE(SUM(discount),0), 2),
        'net_purchases',      ROUND(COALESCE(SUM(gross - discount),0), 2),
        'tax',                ROUND(COALESCE(SUM(tax),0), 2),
        'returns',            ROUND(COALESCE(SUM(returns),0), 2),
        'net_after_returns',  ROUND(COALESCE(SUM(gross - discount - returns),0), 2),
        'quantity',           COALESCE(SUM(qty),0),
        'purchase_documents', COALESCE(SUM(purchase_docs),0),
        'return_documents',   COALESCE(SUM(return_docs),0),
        'unconvertible_document_count',
          (SELECT purchase_docs + return_docs FROM unconvertible)
      ) FROM agg
    ),
    'unconvertible', (
      SELECT jsonb_build_object(
        'purchase_documents', u.purchase_docs,
        'return_documents',   u.return_docs,
        'total',              u.purchase_docs + u.return_docs
      ) FROM unconvertible u
    ),
    'paging', jsonb_build_object(
      'total_rows', (SELECT COUNT(*) FROM agg),
      'limit', _limit,
      'offset', GREATEST(COALESCE(_offset, 0), 0)
    )
  )
  INTO v_result;

  RETURN v_result;
END;
$function$;

-- ---------------------------------------------------------------------
-- finance_sales_revenue_reconciliation
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.finance_sales_revenue_reconciliation(_org_id uuid, _from date, _to date, _business_id uuid DEFAULT NULL::uuid, _branch_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_doc_net           numeric := 0;
  v_revenue           numeric := 0;
  v_returns_acct      numeric := 0;
  v_discount          numeric := 0;
  v_ledger_net        numeric := 0;
  v_variance          numeric := 0;
  v_unconv_invoices   bigint  := 0;
  v_unconv_credits    bigint  := 0;
BEGIN
  IF NOT public.finance_can_read_org(_org_id) THEN
    RAISE EXCEPTION 'forbidden: not a member of this organization' USING ERRCODE = '42501';
  END IF;
  IF _from IS NULL OR _to IS NULL THEN
    RAISE EXCEPTION 'from and to dates are required' USING ERRCODE = '22023';
  END IF;

  -- Document side: only documents with conversion evidence contribute.
  SELECT
    COALESCE(SUM(i.subtotal * r.rate) FILTER (WHERE r.rate IS NOT NULL), 0),
    COUNT(*) FILTER (WHERE r.rate IS NULL)
  INTO v_doc_net, v_unconv_invoices
  FROM public.invoices i
  LEFT JOIN public.businesses biz ON biz.id = i.business_id
  CROSS JOIN LATERAL (
    SELECT public.fx_report_document_rate(i.currency, i.exchange_rate, biz.base_currency) AS rate
  ) r
  WHERE i.organization_id = _org_id
    AND (_business_id IS NULL OR i.business_id = _business_id)
    AND (_branch_id IS NULL OR i.branch_id = _branch_id)
    AND i.issue_date BETWEEN _from AND _to
    AND i.journal_entry_id IS NOT NULL
    AND i.voided_at IS NULL
    AND i.status NOT IN ('draft','cancelled','voided');

  SELECT
    v_doc_net - COALESCE(SUM(c.subtotal * r.rate) FILTER (WHERE r.rate IS NOT NULL), 0),
    COUNT(*) FILTER (WHERE r.rate IS NULL)
  INTO v_doc_net, v_unconv_credits
  FROM public.credit_notes c
  LEFT JOIN public.businesses biz ON biz.id = c.business_id
  CROSS JOIN LATERAL (
    SELECT public.fx_report_document_rate(c.currency, c.exchange_rate, biz.base_currency) AS rate
  ) r
  WHERE c.organization_id = _org_id
    AND (_business_id IS NULL OR c.business_id = _business_id)
    AND (_branch_id IS NULL OR c.branch_id = _branch_id)
    AND c.issue_date BETWEEN _from AND _to
    AND c.status NOT IN ('draft','void');

  SELECT
    COALESCE(SUM(CASE WHEN a.system_role IN ('sales_revenue','service_revenue')
                      THEN jel.credit - jel.debit END), 0),
    COALESCE(SUM(CASE WHEN a.system_role = 'sales_returns'
                      THEN jel.debit - jel.credit END), 0),
    COALESCE(SUM(CASE WHEN a.system_role = 'discount_given'
                      THEN jel.debit - jel.credit END), 0)
  INTO v_revenue, v_returns_acct, v_discount
  FROM public.journal_entry_lines jel
  JOIN public.journal_entries je ON je.id = jel.journal_entry_id
  JOIN public.accounts a ON a.id = jel.account_id
  WHERE je.organization_id = _org_id
    AND (_business_id IS NULL OR je.business_id = _business_id)
    AND (_branch_id IS NULL OR je.branch_id = _branch_id)
    AND je.status = 'posted'
    AND je.voided_at IS NULL
    AND je.entry_date BETWEEN _from AND _to
    AND a.system_role IN ('sales_revenue','service_revenue','sales_returns','discount_given');

  v_ledger_net := v_revenue - v_returns_acct - v_discount;
  v_variance   := ROUND(v_doc_net - v_ledger_net, 2);

  RETURN jsonb_build_object(
    'from', _from,
    'to', _to,
    'document_net_sales', ROUND(v_doc_net, 2),
    'gl_revenue', ROUND(v_revenue, 2),
    'gl_sales_returns', ROUND(v_returns_acct, 2),
    'gl_discounts_given', ROUND(v_discount, 2),
    'ledger_net_sales', ROUND(v_ledger_net, 2),
    'variance', v_variance,
    'unconvertible_invoice_count', v_unconv_invoices,
    'unconvertible_credit_note_count', v_unconv_credits,
    'unconvertible_document_count', v_unconv_invoices + v_unconv_credits,
    -- A reconciliation cannot claim a tie-out while documents carry no
    -- conversion evidence: their value is unknown, not zero.
    'in_balance', ABS(v_variance) <= 0.01
                  AND (v_unconv_invoices + v_unconv_credits) = 0
  );
END;
$function$;

-- ---------------------------------------------------------------------
-- finance_purchase_expense_reconciliation
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.finance_purchase_expense_reconciliation(_org_id uuid, _from date, _to date, _business_id uuid DEFAULT NULL::uuid, _branch_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_doc_net       numeric := 0;
  v_doc_returns   numeric := 0;
  v_gl_debits     numeric := 0;
  v_gl_returns    numeric := 0;
  v_ledger_net    numeric := 0;
  v_variance      numeric := 0;
  v_unconv_bills  bigint  := 0;
  v_unconv_vcns   bigint  := 0;
BEGIN
  IF NOT public.finance_can_read_org(_org_id) THEN
    RAISE EXCEPTION 'forbidden: not a member of this organization' USING ERRCODE = '42501';
  END IF;
  IF _from IS NULL OR _to IS NULL THEN
    RAISE EXCEPTION 'from and to dates are required' USING ERRCODE = '22023';
  END IF;

  -- Document side: bills net of header discount, less vendor credit notes.
  -- Only documents with conversion evidence contribute.
  SELECT
    COALESCE(SUM((COALESCE(b.subtotal,0) - COALESCE(b.discount_amount,0)) * r.rate)
             FILTER (WHERE r.rate IS NOT NULL), 0),
    COUNT(*) FILTER (WHERE r.rate IS NULL)
  INTO v_doc_net, v_unconv_bills
  FROM public.bills b
  LEFT JOIN public.businesses biz ON biz.id = b.business_id
  CROSS JOIN LATERAL (
    SELECT public.fx_report_document_rate(b.currency, b.currency_rate, biz.base_currency) AS rate
  ) r
  WHERE b.organization_id = _org_id
    AND (_business_id IS NULL OR b.business_id = _business_id)
    AND (_branch_id IS NULL OR b.branch_id = _branch_id)
    AND b.bill_date BETWEEN _from AND _to
    AND b.journal_entry_id IS NOT NULL
    AND b.voided_at IS NULL
    AND b.status NOT IN ('draft','void');

  SELECT
    COALESCE(SUM(COALESCE(c.subtotal,0) * r.rate) FILTER (WHERE r.rate IS NOT NULL), 0),
    COUNT(*) FILTER (WHERE r.rate IS NULL)
  INTO v_doc_returns, v_unconv_vcns
  FROM public.vendor_credit_notes c
  LEFT JOIN public.businesses biz ON biz.id = c.business_id
  CROSS JOIN LATERAL (
    SELECT public.fx_report_document_rate(c.currency, c.exchange_rate, biz.base_currency) AS rate
  ) r
  WHERE c.organization_id = _org_id
    AND (_business_id IS NULL OR c.business_id = _business_id)
    AND (_branch_id IS NULL OR c.branch_id = _branch_id)
    AND c.credit_date BETWEEN _from AND _to
    AND c.journal_entry_id IS NOT NULL
    AND c.reversed_at IS NULL
    AND lower(COALESCE(c.status, '')) NOT IN ('draft','void','voided','cancelled','rejected');

  -- Ledger side: the purchase-side legs of the journal entries these very
  -- documents produced, excluding the AP control and recoverable input tax.
  SELECT COALESCE(SUM(jel.debit - jel.credit), 0)
  INTO v_gl_debits
  FROM public.bills b
  JOIN public.journal_entries je ON je.id = b.journal_entry_id
  JOIN public.journal_entry_lines jel ON jel.journal_entry_id = je.id
  LEFT JOIN public.accounts a ON a.id = jel.account_id
  WHERE b.organization_id = _org_id
    AND (_business_id IS NULL OR b.business_id = _business_id)
    AND (_branch_id IS NULL OR b.branch_id = _branch_id)
    AND b.bill_date BETWEEN _from AND _to
    AND b.voided_at IS NULL
    AND b.status NOT IN ('draft','void')
    AND je.status = 'posted'
    AND je.voided_at IS NULL
    AND COALESCE(a.system_role, '') NOT IN ('accounts_payable','input_tax','output_tax');

  SELECT COALESCE(SUM(jel.credit - jel.debit), 0)
  INTO v_gl_returns
  FROM public.vendor_credit_notes c
  JOIN public.journal_entries je ON je.id = c.journal_entry_id
  JOIN public.journal_entry_lines jel ON jel.journal_entry_id = je.id
  LEFT JOIN public.accounts a ON a.id = jel.account_id
  WHERE c.organization_id = _org_id
    AND (_business_id IS NULL OR c.business_id = _business_id)
    AND (_branch_id IS NULL OR c.branch_id = _branch_id)
    AND c.credit_date BETWEEN _from AND _to
    AND c.reversed_at IS NULL
    AND lower(COALESCE(c.status, '')) NOT IN ('draft','void','voided','cancelled','rejected')
    AND je.status = 'posted'
    AND je.voided_at IS NULL
    AND COALESCE(a.system_role, '') NOT IN ('accounts_payable','input_tax','output_tax');

  v_ledger_net := v_gl_debits - v_gl_returns;
  v_variance   := ROUND((v_doc_net - v_doc_returns) - v_ledger_net, 2);

  RETURN jsonb_build_object(
    'from', _from,
    'to', _to,
    'document_net_purchases', ROUND(v_doc_net - v_doc_returns, 2),
    'document_purchases', ROUND(v_doc_net, 2),
    'document_returns', ROUND(v_doc_returns, 2),
    'gl_purchase_debits', ROUND(v_gl_debits, 2),
    'gl_purchase_returns', ROUND(v_gl_returns, 2),
    'ledger_net_purchases', ROUND(v_ledger_net, 2),
    'variance', v_variance,
    'unconvertible_bill_count', v_unconv_bills,
    'unconvertible_vendor_credit_note_count', v_unconv_vcns,
    'unconvertible_document_count', v_unconv_bills + v_unconv_vcns,
    'in_balance', ABS(v_variance) <= 0.01
                  AND (v_unconv_bills + v_unconv_vcns) = 0
  );
END;
$function$;