
-- Phase 3 — Recipient-centred financial continuity.
-- Read-only projections over existing writers (payslip_lines → garnishment_ledger
-- accruals, legal_order_remittance_lines paid). No new writer paths.

-- 1. Per-recipient outstanding view -----------------------------------------
CREATE OR REPLACE VIEW public.legal_recipient_outstanding
WITH (security_invoker = on) AS
WITH accrued AS (
  SELECT
    lor.organization_id,
    lor.recipient_id,
    SUM(gl.amount)                  AS accrued_total,
    MIN(gl.payment_date)            AS oldest_accrual_date,
    MAX(gl.payment_date)            AS latest_accrual_date,
    COUNT(DISTINCT gl.employee_id)  AS employee_count,
    COUNT(DISTINCT gl.garnishment_id) AS order_count
  FROM public.garnishment_ledger gl
  JOIN public.legal_orders_records lor ON lor.id = gl.garnishment_id
  WHERE lor.recipient_id IS NOT NULL
  GROUP BY lor.organization_id, lor.recipient_id
),
paid AS (
  SELECT
    lor.organization_id,
    lor.recipient_id,
    SUM(rl.amount)             AS paid_total,
    MAX(rl.payment_date)       AS last_remittance_date
  FROM public.legal_order_remittance_lines rl
  JOIN public.legal_orders_records lor ON lor.id = rl.garnishment_id
  WHERE lor.recipient_id IS NOT NULL
  GROUP BY lor.organization_id, lor.recipient_id
)
SELECT
  r.id                          AS recipient_id,
  r.organization_id,
  r.display_name,
  r.recipient_type_code,
  r.contact_id,
  r.jurisdiction_country,
  r.jurisdiction_region,
  r.is_active,
  COALESCE(a.accrued_total, 0)  AS accrued_total,
  COALESCE(p.paid_total, 0)     AS paid_total,
  COALESCE(a.accrued_total, 0) - COALESCE(p.paid_total, 0) AS outstanding_balance,
  a.oldest_accrual_date,
  a.latest_accrual_date,
  p.last_remittance_date,
  COALESCE(a.employee_count, 0) AS employee_count,
  COALESCE(a.order_count, 0)    AS order_count,
  (r.contact_id IS NOT NULL)    AS is_linked_to_contact
FROM public.legal_recipients r
LEFT JOIN accrued a ON a.recipient_id = r.id AND a.organization_id = r.organization_id
LEFT JOIN paid    p ON p.recipient_id = r.id AND p.organization_id = r.organization_id;

GRANT SELECT ON public.legal_recipient_outstanding TO authenticated;

COMMENT ON VIEW public.legal_recipient_outstanding IS
  'ADR-0093 Phase 3: per-recipient accrued vs. remitted rollup. Positive outstanding_balance = money owed to the third party.';

-- 2. Per-recipient reconciliation statement ---------------------------------
CREATE OR REPLACE FUNCTION public.legal_recipient_statement(
  p_recipient_id uuid,
  p_from date,
  p_to   date
)
RETURNS TABLE (
  entry_date    date,
  entry_kind    text,          -- 'accrual' | 'remittance'
  garnishment_id uuid,
  employee_id   uuid,
  amount        numeric,        -- accrual = +, remittance = -
  reference     text,
  payroll_run_id uuid,
  payment_id    uuid
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  WITH accruals AS (
    SELECT
      gl.payment_date          AS entry_date,
      'accrual'::text          AS entry_kind,
      gl.garnishment_id,
      gl.employee_id,
      gl.amount                AS amount,
      NULL::text               AS reference,
      gl.payroll_run_id,
      NULL::uuid               AS payment_id
    FROM public.garnishment_ledger gl
    JOIN public.legal_orders_records lor ON lor.id = gl.garnishment_id
    WHERE lor.recipient_id = p_recipient_id
      AND gl.payment_date BETWEEN p_from AND p_to
  ),
  remittances AS (
    SELECT
      rl.payment_date          AS entry_date,
      'remittance'::text       AS entry_kind,
      rl.garnishment_id,
      lor.employee_id,
      -rl.amount               AS amount,
      rl.reference_number      AS reference,
      NULL::uuid               AS payroll_run_id,
      rl.payment_id
    FROM public.legal_order_remittance_lines rl
    JOIN public.legal_orders_records lor ON lor.id = rl.garnishment_id
    WHERE lor.recipient_id = p_recipient_id
      AND rl.payment_date BETWEEN p_from AND p_to
  )
  SELECT * FROM accruals
  UNION ALL
  SELECT * FROM remittances
  ORDER BY entry_date ASC, entry_kind DESC;
$$;

REVOKE ALL ON FUNCTION public.legal_recipient_statement(uuid, date, date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.legal_recipient_statement(uuid, date, date) TO authenticated;

COMMENT ON FUNCTION public.legal_recipient_statement(uuid, date, date) IS
  'ADR-0093 Phase 3: reconciliation-ready statement for a single legal recipient over [from, to]. Accruals are positive, remittances negative; frontend renders the running balance.';
