-- =====================================================================
-- Phase 6/7 — Purchases & payables reporting parity.
--
-- `finance_purchase_analysis` mirrors `finance_sales_analysis`:
--   * one engine, one `_dimension` parameter (supplier / product / category
--     / account / branch / month) — not six report pages;
--   * ledger-posted, non-void documents only (`journal_entry_id IS NOT NULL`,
--     `voided_at IS NULL`, status excluded);
--   * BASE currency (bills carry `currency_rate`, vendor credit notes carry
--     `exchange_rate`);
--   * vendor credit notes subtracted as purchase returns;
--   * header discounts allocated pro-rata by line value so the product and
--     category dimensions stay additive to the supplier dimension;
--   * strict org / business / branch scoping — never `OR branch_id IS NULL`.
--
-- `finance_purchase_expense_reconciliation` ties document net purchases to the
-- journal entries those documents actually produced, excluding the AP control
-- and input-tax legs. A variance is a bookkeeping finding, never tuned away.
-- =====================================================================

CREATE OR REPLACE FUNCTION public.finance_purchase_analysis(
  _org_id uuid,
  _from date,
  _to date,
  _business_id uuid DEFAULT NULL,
  _branch_id uuid DEFAULT NULL,
  _dimension text DEFAULT 'supplier',
  _limit integer DEFAULT NULL,
  _offset integer DEFAULT 0
)
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
           COALESCE(NULLIF(b.currency_rate, 0), 1) AS rate,
           COALESCE(b.discount_amount, 0)          AS header_discount
    FROM public.bills b
    WHERE b.organization_id = _org_id
      AND (_business_id IS NULL OR b.business_id = _business_id)
      AND (_branch_id IS NULL OR b.branch_id = _branch_id)
      AND b.bill_date BETWEEN _from AND _to
      AND b.journal_entry_id IS NOT NULL
      AND b.voided_at IS NULL
      AND b.status NOT IN ('draft','void')
  ), vcn AS (
    SELECT c.id, c.vendor_id, c.branch_id, c.credit_date,
           COALESCE(NULLIF(c.exchange_rate, 0), 1) AS rate
    FROM public.vendor_credit_notes c
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
        'return_documents',   COALESCE(SUM(return_docs),0)
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

REVOKE ALL ON FUNCTION public.finance_purchase_analysis(uuid, date, date, uuid, uuid, text, integer, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.finance_purchase_analysis(uuid, date, date, uuid, uuid, text, integer, integer) FROM anon;
GRANT EXECUTE ON FUNCTION public.finance_purchase_analysis(uuid, date, date, uuid, uuid, text, integer, integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.finance_purchase_analysis(uuid, date, date, uuid, uuid, text, integer, integer) TO service_role;


CREATE OR REPLACE FUNCTION public.finance_purchase_expense_reconciliation(
  _org_id uuid,
  _from date,
  _to date,
  _business_id uuid DEFAULT NULL,
  _branch_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_doc_net     numeric := 0;
  v_doc_returns numeric := 0;
  v_gl_debits   numeric := 0;
  v_gl_returns  numeric := 0;
  v_ledger_net  numeric := 0;
  v_variance    numeric := 0;
BEGIN
  IF NOT public.finance_can_read_org(_org_id) THEN
    RAISE EXCEPTION 'forbidden: not a member of this organization' USING ERRCODE = '42501';
  END IF;
  IF _from IS NULL OR _to IS NULL THEN
    RAISE EXCEPTION 'from and to dates are required' USING ERRCODE = '22023';
  END IF;

  -- Document side: bills net of header discount, less vendor credit notes.
  SELECT COALESCE(SUM((COALESCE(b.subtotal,0) - COALESCE(b.discount_amount,0))
                      * COALESCE(NULLIF(b.currency_rate,0),1)), 0)
  INTO v_doc_net
  FROM public.bills b
  WHERE b.organization_id = _org_id
    AND (_business_id IS NULL OR b.business_id = _business_id)
    AND (_branch_id IS NULL OR b.branch_id = _branch_id)
    AND b.bill_date BETWEEN _from AND _to
    AND b.journal_entry_id IS NOT NULL
    AND b.voided_at IS NULL
    AND b.status NOT IN ('draft','void');

  SELECT COALESCE(SUM(COALESCE(c.subtotal,0) * COALESCE(NULLIF(c.exchange_rate,0),1)), 0)
  INTO v_doc_returns
  FROM public.vendor_credit_notes c
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
    'in_balance', ABS(v_variance) <= 0.01
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.finance_purchase_expense_reconciliation(uuid, date, date, uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.finance_purchase_expense_reconciliation(uuid, date, date, uuid, uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.finance_purchase_expense_reconciliation(uuid, date, date, uuid, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.finance_purchase_expense_reconciliation(uuid, date, date, uuid, uuid) TO service_role;