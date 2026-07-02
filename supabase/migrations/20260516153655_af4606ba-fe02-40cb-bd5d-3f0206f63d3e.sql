-- Banking ownership — gap-closing (G4, G5)
-- G4: enforce bank_reconciliation_sessions.business_id/branch_id mirror parent bank_account
-- G5: prevent manual no-provider duplicate (business_id, account_number) entries

-- G5: partial unique index for manual rows with no provider at all
CREATE UNIQUE INDEX IF NOT EXISTS bank_accounts_manual_no_provider_unique
  ON public.bank_accounts (business_id, account_number)
  WHERE provider_id IS NULL AND account_number IS NOT NULL;

COMMENT ON INDEX public.bank_accounts_manual_no_provider_unique IS
  'G5: prevent duplicate manual bank-account rows with no external provider in the same business';

-- G4: BEFORE trigger to align reconciliation session scope with parent account
CREATE OR REPLACE FUNCTION public.enforce_recon_session_scope_matches_account()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_business_id uuid;
  v_branch_id   uuid;
  v_org_id      uuid;
BEGIN
  SELECT business_id, branch_id, organization_id
    INTO v_business_id, v_branch_id, v_org_id
  FROM public.bank_accounts
  WHERE id = NEW.bank_account_id;

  IF v_org_id IS NULL THEN
    RAISE EXCEPTION 'bank_account % not found', NEW.bank_account_id
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  NEW.organization_id := v_org_id;
  NEW.business_id     := v_business_id;
  NEW.branch_id       := v_branch_id;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_enforce_recon_session_scope ON public.bank_reconciliation_sessions;
CREATE TRIGGER trg_enforce_recon_session_scope
  BEFORE INSERT OR UPDATE OF bank_account_id, business_id, branch_id, organization_id
  ON public.bank_reconciliation_sessions
  FOR EACH ROW
  EXECUTE FUNCTION public.enforce_recon_session_scope_matches_account();

COMMENT ON FUNCTION public.enforce_recon_session_scope_matches_account() IS
  'G4: bank_reconciliation_sessions org/business/branch must mirror parent bank_account';

-- Backfill any drifted rows
UPDATE public.bank_reconciliation_sessions s
   SET organization_id = ba.organization_id,
       business_id     = ba.business_id,
       branch_id       = ba.branch_id
  FROM public.bank_accounts ba
 WHERE ba.id = s.bank_account_id
   AND (s.organization_id IS DISTINCT FROM ba.organization_id
        OR s.business_id IS DISTINCT FROM ba.business_id
        OR s.branch_id   IS DISTINCT FROM ba.branch_id);