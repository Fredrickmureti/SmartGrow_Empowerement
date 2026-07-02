-- Odoo-grade invariant: an ACTIVE bank account must have a GL link.
-- Without it, balances cannot be ledger-derived and reconciliation has no
-- target account. Inactive accounts are exempt (they may be legacy / parked).
CREATE OR REPLACE FUNCTION public.enforce_active_bank_account_has_gl()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.is_active = true AND NEW.account_id IS NULL THEN
    RAISE EXCEPTION
      'Active bank account "%" must be linked to a Chart-of-Accounts entry (account_id). '
      'Either set a GL account or mark this bank account inactive.',
      COALESCE(NEW.name, NEW.id::text)
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_enforce_active_bank_account_has_gl ON public.bank_accounts;
CREATE TRIGGER trg_enforce_active_bank_account_has_gl
BEFORE INSERT OR UPDATE OF is_active, account_id ON public.bank_accounts
FOR EACH ROW
EXECUTE FUNCTION public.enforce_active_bank_account_has_gl();