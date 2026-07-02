-- =========================================================================
-- Conform the two newest account-side guards to the project-wide
-- lifecycle-bypass contract used by every other BEFORE DELETE guard
-- (assert_app_installed_for_write, prevent_archived_account_writes,
--  guard_business_archive, etc.).
--
-- Bypass when:
--   1. app.reset_in_progress = OLD.organization_id   (reset_organization_data)
--   2. app.tenant_delete     = OLD.organization_id   (platform_delete_organization)
--   3. caller is a platform admin                     (lifecycle ops)
--
-- All other behaviour — including the audit-log writes and every error
-- message — is preserved verbatim so normal tenant users are unaffected.
-- =========================================================================

CREATE OR REPLACE FUNCTION public.enforce_account_lifecycle()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _has_postings boolean;
  _is_mapped boolean;
  _reset_org text;
  _tenant_delete_org text;
  _caller uuid;
  _is_lifecycle boolean;
BEGIN
  _reset_org         := current_setting('app.reset_in_progress', true);
  _tenant_delete_org := current_setting('app.tenant_delete', true);
  _caller            := auth.uid();
  _is_lifecycle :=
       (_reset_org IS NOT NULL AND _reset_org = COALESCE(NEW.organization_id, OLD.organization_id)::text)
    OR (_tenant_delete_org IS NOT NULL AND _tenant_delete_org = COALESCE(NEW.organization_id, OLD.organization_id)::text)
    OR (_caller IS NOT NULL AND public.is_platform_admin(_caller));

  IF TG_OP = 'DELETE' THEN
    -- Platform-authorised lifecycle path: skip business guards entirely.
    -- Tenant purge is already gated by is_platform_admin in the RPC and
    -- by the GUC contract; per-account guards must not block it.
    IF _is_lifecycle THEN
      RETURN OLD;
    END IF;

    SELECT EXISTS (SELECT 1 FROM public.journal_entry_lines WHERE account_id = OLD.id) INTO _has_postings;
    SELECT EXISTS (SELECT 1 FROM public.default_account_settings WHERE account_id = OLD.id) INTO _is_mapped;

    IF OLD.is_system THEN
      RAISE EXCEPTION 'Cannot delete system account "%". Archive it instead.', OLD.name
        USING ERRCODE = 'restrict_violation';
    END IF;
    IF _has_postings THEN
      RAISE EXCEPTION 'Cannot delete account "%": it has posted transactions. Archive it instead.', OLD.name
        USING ERRCODE = 'restrict_violation';
    END IF;
    IF _is_mapped THEN
      RAISE EXCEPTION 'Cannot delete account "%": it is mapped as a default account. Reassign the mapping first.', OLD.name
        USING ERRCODE = 'restrict_violation';
    END IF;

    INSERT INTO public.account_change_audit_log
      (account_id, organization_id, business_id, change_type, old_value, changed_by, reason)
    VALUES (OLD.id, OLD.organization_id, OLD.business_id, 'delete',
      to_jsonb(OLD), auth.uid(), 'User-initiated delete');
    RETURN OLD;
  END IF;

  IF TG_OP = 'UPDATE' THEN
    -- Lifecycle ops (e.g. repair_legacy_statutory_accounts, platform admin
    -- migrations) may need to rename/recode/archive system accounts.
    IF _is_lifecycle THEN
      RETURN NEW;
    END IF;

    IF NEW.account_type IS DISTINCT FROM OLD.account_type THEN
      IF OLD.is_system THEN
        RAISE EXCEPTION 'Cannot change account_type of system account "%".', OLD.name
          USING ERRCODE = 'restrict_violation';
      END IF;
      SELECT EXISTS (SELECT 1 FROM public.journal_entry_lines WHERE account_id = OLD.id) INTO _has_postings;
      IF _has_postings THEN
        RAISE EXCEPTION 'Cannot change account_type of "%": % has posted transactions.', OLD.name, OLD.code
          USING ERRCODE = 'restrict_violation';
      END IF;
      INSERT INTO public.account_change_audit_log
        (account_id, organization_id, business_id, change_type, old_value, new_value, changed_by)
      VALUES (NEW.id, NEW.organization_id, NEW.business_id, 'type_change',
        jsonb_build_object('account_type', OLD.account_type),
        jsonb_build_object('account_type', NEW.account_type),
        auth.uid());
    END IF;

    IF NEW.code IS DISTINCT FROM OLD.code THEN
      IF OLD.is_system THEN
        RAISE EXCEPTION 'Cannot change code of system account "%".', OLD.name
          USING ERRCODE = 'restrict_violation';
      END IF;
      INSERT INTO public.account_change_audit_log
        (account_id, organization_id, business_id, change_type, old_value, new_value, changed_by)
      VALUES (NEW.id, NEW.organization_id, NEW.business_id, 'recode',
        jsonb_build_object('code', OLD.code),
        jsonb_build_object('code', NEW.code),
        auth.uid());
    END IF;

    IF NEW.name IS DISTINCT FROM OLD.name THEN
      INSERT INTO public.account_change_audit_log
        (account_id, organization_id, business_id, change_type, old_value, new_value, changed_by)
      VALUES (NEW.id, NEW.organization_id, NEW.business_id, 'rename',
        jsonb_build_object('name', OLD.name),
        jsonb_build_object('name', NEW.name),
        auth.uid());
    END IF;

    IF NEW.is_active IS DISTINCT FROM OLD.is_active THEN
      INSERT INTO public.account_change_audit_log
        (account_id, organization_id, business_id, change_type, old_value, new_value, changed_by)
      VALUES (NEW.id, NEW.organization_id, NEW.business_id,
        CASE WHEN NEW.is_active THEN 'restore' ELSE 'archive' END,
        jsonb_build_object('is_active', OLD.is_active),
        jsonb_build_object('is_active', NEW.is_active),
        auth.uid());
    END IF;

    RETURN NEW;
  END IF;

  RETURN NULL;
END;
$$;

COMMENT ON FUNCTION public.enforce_account_lifecycle() IS
  'BEFORE UPDATE/DELETE on accounts. Enforces system-account / posted-transactions / default-mapping rules for normal tenant operations. Bypasses for (a) tenant reset/purge in progress (app.reset_in_progress or app.tenant_delete GUC matches OLD.organization_id) and (b) platform admin callers — same contract used by assert_app_installed_for_write and the other lifecycle guards.';


-- =========================================================================
-- Same bypass for the required-system-role mapping guard. Without this,
-- the FK cascade from organizations -> default_account_settings would
-- raise "Cannot delete the only mapping for required system role …"
-- during platform tenant purge.
-- =========================================================================
CREATE OR REPLACE FUNCTION public.prevent_unmapped_system_role_delete()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  _required_keys text[] := ARRAY[
    'cash','bank','accounts_receivable','accounts_payable',
    'sales_revenue','cost_of_goods_sold',
    'retained_earnings','opening_balance_equity',
    'output_tax','input_tax','inventory'
  ];
  _replacement_exists boolean;
  _reset_org text;
  _tenant_delete_org text;
  _caller uuid;
BEGIN
  -- Lifecycle bypass — same contract as enforce_account_lifecycle.
  _reset_org         := current_setting('app.reset_in_progress', true);
  _tenant_delete_org := current_setting('app.tenant_delete', true);
  _caller            := auth.uid();
  IF (_reset_org IS NOT NULL AND _reset_org = OLD.organization_id::text)
     OR (_tenant_delete_org IS NOT NULL AND _tenant_delete_org = OLD.organization_id::text)
     OR (_caller IS NOT NULL AND public.is_platform_admin(_caller)) THEN
    RETURN OLD;
  END IF;

  IF NOT (OLD.setting_key = ANY(_required_keys)) THEN
    RETURN OLD;
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM public.default_account_settings
     WHERE setting_key = OLD.setting_key
       AND business_id IS NOT DISTINCT FROM OLD.business_id
       AND organization_id IS NOT DISTINCT FROM OLD.organization_id
       AND id <> OLD.id
  ) INTO _replacement_exists;

  IF NOT _replacement_exists THEN
    RAISE EXCEPTION 'Cannot delete the only mapping for required system role "%". Map a replacement account first.', OLD.setting_key
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN OLD;
END;
$function$;

COMMENT ON FUNCTION public.prevent_unmapped_system_role_delete() IS
  'BEFORE DELETE on default_account_settings. Blocks removing the last mapping for required system roles during normal tenant ops. Bypasses for tenant reset/purge in progress and platform admin callers.';