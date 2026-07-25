-- Retire the legacy 3-arg overload that mutated loan state directly.
DROP FUNCTION IF EXISTS public.employee_loan_close_on_termination(uuid, numeric, text);

-- Thin compatibility wrapper: same 3-arg signature, delegates to the canonical
-- 7-arg RPC. `_final_settlement_amount` maps to `_recovered_amount`;
-- termination_date defaults to today; write-off is enabled so a residual
-- balance is cleared through the canonical path rather than left dangling.
CREATE OR REPLACE FUNCTION public.employee_loan_close_on_termination(
  _loan_id uuid,
  _final_settlement_amount numeric,
  _reason text
)
RETURNS public.employee_loans
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE r public.employee_loans;
BEGIN
  PERFORM public.employee_loan_close_on_termination(
    _loan_id,
    CURRENT_DATE,
    _reason,
    NULL::uuid,
    NULL::uuid,
    COALESCE(_final_settlement_amount, 0),
    true);
  SELECT * INTO r FROM public.employee_loans WHERE id=_loan_id;
  RETURN r;
END
$function$;

REVOKE ALL ON FUNCTION public.employee_loan_close_on_termination(uuid, numeric, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.employee_loan_close_on_termination(uuid, numeric, text) TO authenticated, service_role;