CREATE OR REPLACE FUNCTION public.accounts_assert_deactivatable()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _reset_org         text;
  _tenant_delete_org text;
  _caller            uuid;
BEGIN
  IF NEW.is_active OR OLD.is_active = false THEN
    RETURN NEW;
  END IF;

  -- Platform-authorised lifecycle paths (tenant reset / purge / platform admin)
  -- keep their existing freedom; this guard is a tenant-level business rule.
  _reset_org         := current_setting('app.reset_in_progress', true);
  _tenant_delete_org := current_setting('app.tenant_delete', true);
  _caller            := auth.uid();
  IF (_reset_org IS NOT NULL AND _reset_org = COALESCE(NEW.organization_id, OLD.organization_id)::text)
     OR (_tenant_delete_org IS NOT NULL AND _tenant_delete_org = COALESCE(NEW.organization_id, OLD.organization_id)::text)
     OR (_caller IS NOT NULL AND public.is_platform_admin(_caller))
  THEN
    RETURN NEW;
  END IF;

  IF EXISTS (SELECT 1 FROM public.journal_entry_lines l WHERE l.account_id = OLD.id) THEN
    RAISE EXCEPTION 'Cannot archive account "% %": it has posted transactions.', OLD.code, OLD.name
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF EXISTS (SELECT 1 FROM public.mf_account_mappings m WHERE m.account_id = OLD.id) THEN
    RAISE EXCEPTION 'Cannot archive account "% %": it is mapped as a lending account. Remap it first.', OLD.code, OLD.name
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF EXISTS (SELECT 1 FROM public.default_account_settings s WHERE s.account_id = OLD.id) THEN
    RAISE EXCEPTION 'Cannot archive account "% %": it is mapped as a default account. Reassign the mapping first.', OLD.code, OLD.name
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF EXISTS (SELECT 1 FROM public.default_accounts d WHERE d.account_id = OLD.id) THEN
    RAISE EXCEPTION 'Cannot archive account "% %": it is mapped as a default account. Reassign the mapping first.', OLD.code, OLD.name
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_accounts_assert_deactivatable ON public.accounts;
CREATE TRIGGER trg_accounts_assert_deactivatable
  BEFORE UPDATE OF is_active ON public.accounts
  FOR EACH ROW
  EXECUTE FUNCTION public.accounts_assert_deactivatable();

-- Rollback:
-- DROP TRIGGER IF EXISTS trg_accounts_assert_deactivatable ON public.accounts;
-- DROP FUNCTION IF EXISTS public.accounts_assert_deactivatable();
