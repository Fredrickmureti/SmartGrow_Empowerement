CREATE OR REPLACE FUNCTION public.legal_orders_return_extract(
  _organization_id uuid,
  _business_id uuid,
  _period_start date,
  _period_end date,
  _branch_id uuid DEFAULT NULL
)
RETURNS TABLE (
  order_id uuid,
  employee_id uuid,
  authority_id uuid,
  authority_name text,
  authority_code text,
  kind_code text,
  calc_model text,
  priority_class smallint,
  case_reference text,
  start_date date,
  end_date date,
  gross_deducted numeric,
  line_count integer,
  period_start date,
  period_end date
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  SELECT
    lo.id                       AS order_id,
    lo.employee_id              AS employee_id,
    lo.authority_id             AS authority_id,
    COALESCE(auth.name, lo.authority_name) AS authority_name,
    auth.code                   AS authority_code,
    lo.kind_code::text          AS kind_code,
    lo.calc_model::text         AS calc_model,
    lo.priority_class           AS priority_class,
    lo.case_reference           AS case_reference,
    lo.start_date               AS start_date,
    lo.end_date                 AS end_date,
    COALESCE(SUM(rl.amount), 0)::numeric AS gross_deducted,
    COUNT(rl.id)::int           AS line_count,
    _period_start               AS period_start,
    _period_end                 AS period_end
  FROM public.legal_order_remittance_lines rl
  JOIN public.legal_orders lo
    ON lo.id = rl.garnishment_id
  LEFT JOIN public.legal_order_authorities auth
    ON auth.id = lo.authority_id
  WHERE rl.organization_id = _organization_id
    AND rl.business_id     = _business_id
    AND rl.payment_date   >= _period_start
    AND rl.payment_date   <= _period_end
  GROUP BY
    lo.id, lo.employee_id, lo.authority_id, auth.name, auth.code,
    lo.authority_name, lo.kind_code, lo.calc_model, lo.priority_class,
    lo.case_reference, lo.start_date, lo.end_date
  ORDER BY
    COALESCE(lo.priority_class, 99) ASC,
    COALESCE(auth.name, lo.authority_name, '') ASC,
    lo.id ASC;
$$;

GRANT EXECUTE ON FUNCTION public.legal_orders_return_extract(uuid, uuid, date, date, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.legal_orders_return_extract(uuid, uuid, date, date, uuid) TO service_role;

COMMENT ON FUNCTION public.legal_orders_return_extract(uuid, uuid, date, date, uuid) IS
  'Statutory-return projection of legal-order deductions inside a period. Reads through the public.legal_orders view so the "reads go through the view" invariant is preserved. Grouped by order, ordered by priority_class then authority name.';