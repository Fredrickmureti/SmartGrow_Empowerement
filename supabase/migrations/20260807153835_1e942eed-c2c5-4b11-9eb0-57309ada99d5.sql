-- Phase B completion: customer credit GL tie-out

CREATE OR REPLACE VIEW public.customer_credit_tieout AS
WITH cc_accounts AS (
  SELECT DISTINCT b.organization_id, b.id AS business_id,
         public.customer_credit_account(b.id) AS account_id
  FROM public.businesses b
),
gl AS (
  SELECT ca.organization_id,
         ca.business_id,
         ca.account_id,
         COALESCE(NULLIF(jel.original_currency, ''), bz.base_currency) AS currency,
         sum(COALESCE(COALESCE(jel.original_credit, jel.credit), 0) - COALESCE(COALESCE(jel.original_debit, jel.debit), 0)) AS gl_balance
  FROM cc_accounts ca
  JOIN public.businesses bz ON bz.id = ca.business_id
  JOIN public.journal_entry_lines jel ON jel.account_id = ca.account_id
  JOIN public.journal_entries je ON je.id = jel.journal_entry_id
  WHERE je.status = 'posted'
    AND COALESCE(jel.business_id, ca.business_id) = ca.business_id
  GROUP BY 1,2,3,4
),
sub AS (
  SELECT ccb.organization_id, ccb.business_id,
         ca.account_id,
         ccb.currency,
         sum(ccb.balance) AS sub_balance
  FROM public.customer_credit_balances ccb
  JOIN cc_accounts ca ON ca.business_id = ccb.business_id
  GROUP BY 1,2,3,4
)
SELECT
  COALESCE(gl.organization_id, sub.organization_id) AS organization_id,
  COALESCE(gl.business_id, sub.business_id)         AS business_id,
  COALESCE(gl.account_id, sub.account_id)           AS account_id,
  a.code AS account_code,
  a.name AS account_name,
  a.system_role,
  COALESCE(gl.currency, sub.currency)               AS currency,
  COALESCE(gl.gl_balance, 0)                        AS gl_balance,
  COALESCE(sub.sub_balance, 0)                      AS subledger_balance,
  COALESCE(gl.gl_balance, 0) - COALESCE(sub.sub_balance, 0) AS drift
FROM gl
FULL OUTER JOIN sub
  ON sub.account_id = gl.account_id AND sub.currency = gl.currency
LEFT JOIN public.accounts a ON a.id = COALESCE(gl.account_id, sub.account_id);

COMMENT ON VIEW public.customer_credit_tieout IS
  'Per-business, per-currency tie-out of the dedicated Customer Credits GL account (liability-positive) against customer_credit_balances. Non-zero drift means credit-note liability and the credit ledger have diverged.';

GRANT SELECT ON public.customer_credit_tieout TO authenticated;
GRANT SELECT ON public.customer_credit_tieout TO service_role;

-- Extend the nightly drift snapshot to include customer credit drift
CREATE OR REPLACE FUNCTION public.snapshot_control_account_drift()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_count integer;
  v_cc_count integer;
BEGIN
  INSERT INTO public.control_account_drift_log
    (organization_id, account_id, account_code, account_name, system_role,
     gl_balance, subledger_balance, drift)
  SELECT organization_id, account_id, account_code, account_name, system_role,
         gl_balance, subledger_balance, drift
  FROM public.control_account_tieout
  WHERE abs(drift) > 0.005;
  GET DIAGNOSTICS v_count = ROW_COUNT;

  INSERT INTO public.control_account_drift_log
    (organization_id, account_id, account_code, account_name, system_role,
     gl_balance, subledger_balance, drift)
  SELECT organization_id, account_id, account_code,
         account_name || ' (' || currency || ')',
         COALESCE(system_role, 'customer_credit'),
         gl_balance, subledger_balance, drift
  FROM public.customer_credit_tieout
  WHERE abs(drift) > 0.005;
  GET DIAGNOSTICS v_cc_count = ROW_COUNT;

  RETURN v_count + v_cc_count;
END;
$function$;