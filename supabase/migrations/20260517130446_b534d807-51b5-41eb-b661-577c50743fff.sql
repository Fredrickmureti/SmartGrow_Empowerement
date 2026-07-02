-- Fix schema drift: POS Stage B triggers (2026-05-16) referenced a phantom
-- public.user_organizations table. The canonical membership table in this
-- project is public.user_roles. This broke complete_onboarding because
-- seed_pos_business_data inserts into pos_payment_methods, firing the
-- broken trigger and aborting the onboarding transaction.
--
-- See: docs/audit/2026-05-17-onboarding-user-organizations-verdict.md

CREATE OR REPLACE FUNCTION public.tg_assert_pos_scope_caller_access()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_branch uuid;
  v_org uuid;
  v_is_admin boolean;
BEGIN
  IF v_uid IS NULL THEN RETURN NEW; END IF;

  v_branch := (to_jsonb(NEW) ->> 'branch_id')::uuid;
  v_org    := (to_jsonb(NEW) ->> 'organization_id')::uuid;

  IF v_branch IS NOT NULL THEN
    IF NOT public.user_can_access_branch(v_uid, v_branch) THEN
      RAISE EXCEPTION 'POS scope isolation: user % cannot write branch %', v_uid, v_branch
        USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END IF;

  -- Company-shared row: require org/business admin.
  -- Canonical membership table is public.user_roles (NOT user_organizations).
  SELECT EXISTS (
    SELECT 1 FROM public.user_roles ur
    WHERE ur.user_id = v_uid
      AND ur.organization_id = v_org
      AND ur.is_active = true
      AND ur.role IN ('owner','admin','super_admin')
  ) INTO v_is_admin;

  IF NOT COALESCE(v_is_admin, false) THEN
    RAISE EXCEPTION 'POS company-shared row may only be edited by an organization admin (user %)', v_uid
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.tg_assert_pos_payment_method_scope()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_is_admin boolean;
BEGIN
  IF v_uid IS NULL THEN
    RETURN NEW;
  END IF;

  IF NEW.branch_id IS NOT NULL THEN
    IF NOT public.user_can_access_branch(v_uid, NEW.branch_id) THEN
      RAISE EXCEPTION 'POS payment-method branch isolation: user % cannot write branch %', v_uid, NEW.branch_id
        USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END IF;

  -- Company-default row (branch_id IS NULL): require org/business admin.
  -- Canonical membership table is public.user_roles (NOT user_organizations).
  SELECT EXISTS (
    SELECT 1
    FROM public.user_roles ur
    WHERE ur.user_id = v_uid
      AND ur.organization_id = NEW.organization_id
      AND ur.is_active = true
      AND ur.role IN ('owner','admin','super_admin')
  )
  INTO v_is_admin;

  IF NOT COALESCE(v_is_admin, false) THEN
    RAISE EXCEPTION 'POS payment-method company default may only be edited by an organization admin (user %)', v_uid
      USING ERRCODE = '42501';
  END IF;

  RETURN NEW;
END;
$function$;