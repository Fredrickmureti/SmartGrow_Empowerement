-- R8 cleanup: freeze legacy payroll_remittances, drop dead payroll_statutory_rates.

-- 1) Freeze payroll_remittances inserts (read-only mirror).
CREATE OR REPLACE FUNCTION public.payroll_remittances_read_only_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  RAISE EXCEPTION 'read_only_mirror: payroll_remittances is frozen; use payroll_liabilities + post-remittance-payment edge function. Reads continue via v_payroll_remittances_compat.'
    USING ERRCODE = 'P0001';
END;
$$;

DROP TRIGGER IF EXISTS trg_payroll_remittances_read_only ON public.payroll_remittances;
CREATE TRIGGER trg_payroll_remittances_read_only
BEFORE INSERT ON public.payroll_remittances
FOR EACH ROW EXECUTE FUNCTION public.payroll_remittances_read_only_guard();

COMMENT ON TABLE public.payroll_remittances IS
  'FROZEN legacy mirror. INSERTs blocked by trg_payroll_remittances_read_only. Reads via v_payroll_remittances_compat. Authoritative ledger is payroll_liabilities.';

-- 2) Drop payroll_statutory_rates (verified empty; no app code references after businessScopedTables.ts cleanup).
DROP TABLE IF EXISTS public.payroll_statutory_rates CASCADE;