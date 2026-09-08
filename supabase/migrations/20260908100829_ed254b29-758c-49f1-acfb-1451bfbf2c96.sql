CREATE OR REPLACE FUNCTION public.accounts_assert_deactivatable()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF OLD.is_active AND NOT NEW.is_active THEN
    IF EXISTS (SELECT 1 FROM public.journal_entry_lines l WHERE l.account_id = OLD.id) THEN
      RAISE EXCEPTION 'ACCOUNT_HAS_HISTORY: account % (%) has journal lines and cannot be deactivated', OLD.code, OLD.name;
    END IF;
    IF EXISTS (SELECT 1 FROM public.mf_account_mappings m WHERE m.account_id = OLD.id) THEN
      RAISE EXCEPTION 'ACCOUNT_IS_MAPPED: account % (%) is bound to a lending money-flow mapping and cannot be deactivated', OLD.code, OLD.name;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS accounts_assert_deactivatable_biu ON public.accounts;
CREATE TRIGGER accounts_assert_deactivatable_biu
BEFORE UPDATE OF is_active ON public.accounts
FOR EACH ROW EXECUTE FUNCTION public.accounts_assert_deactivatable();

-- Rollback:
-- DROP TRIGGER IF EXISTS accounts_assert_deactivatable_biu ON public.accounts;
-- DROP FUNCTION IF EXISTS public.accounts_assert_deactivatable();
