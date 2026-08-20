CREATE OR REPLACE FUNCTION public.finance_sales_analysis(
  _org_id uuid,
  _from date,
  _to date,
  _business_id uuid DEFAULT NULL::uuid,
  _branch_id uuid DEFAULT NULL::uuid,
  _dimension text DEFAULT 'customer'::text,
  _limit integer DEFAULT NULL::integer,
  _offset integer DEFAULT 0
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
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
           COALESCE(NULLIF(i.exchange_rate, 0), 1) AS rate
    FROM public.invoices i
    WHERE i.organization_id = _org_id
      AND (_business_id IS NULL OR i.business_id = _business_id)
      AND (_branch_id IS NULL OR i.branch_id = _branch_id)
      AND i.issue_date BETWEEN _from AND _to
      AND i.journal_entry_id IS NOT NULL
      AND i.voided_at IS NULL
      AND i.status NOT IN ('draft','cancelled','voided')
  ), cn AS (
    SELECT c.id, c.contact_id, c.branch_id, c.issue_date,
           COALESCE(NULLIF(c.exchange_rate, 0), 1) AS rate,
           si.salesperson_id
    FROM public.credit_notes c
    LEFT JOIN public.invoices si ON si.id = COALESCE(c.original_invoice_id, c.invoice_id)
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
        'return_documents',  COALESCE(SUM(return_docs),0)
      ) FROM agg
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

REVOKE ALL ON FUNCTION public.finance_sales_analysis(uuid, date, date, uuid, uuid, text, integer, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.finance_sales_analysis(uuid, date, date, uuid, uuid, text, integer, integer) TO authenticated, service_role;