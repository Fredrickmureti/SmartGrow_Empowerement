-- Wave 3 (final hardening): lock the (is_system, system_role) invariant at the table level.
--
-- Up to now the canonical pattern "every system account flows through
-- public.upsert_system_account(...)" was enforced only by code review and
-- by Waves 1A–2 refactoring all 8 call sites. With the accounts table
-- currently empty (workspace was reset) we can promote the invariant from
-- a convention to a database-level guarantee. This is the permanent fix.
--
-- 1. Foreign key: accounts.system_role MUST reference a canonical role.
--    Prevents typos and prevents future code from stamping arbitrary role
--    strings that upsert_system_account would never have produced.
-- 2. Check constraint: any account flagged is_system=true MUST carry a
--    system_role. Removes the "system account without a canonical role"
--    failure mode that originally produced duplicate provisioned accounts.
-- 3. Trigger guard: writing to (system_role, is_system) outside of the
--    canonical helper raises. The helper sets a transaction-local GUC
--    `app.upsert_system_account.in_progress = '1'` while it runs so its
--    own INSERT/UPDATE passes; everything else is rejected.

-- (1) FK to system_account_roles
ALTER TABLE public.accounts
  ADD CONSTRAINT accounts_system_role_fkey
  FOREIGN KEY (system_role)
  REFERENCES public.system_account_roles(role_key)
  ON UPDATE CASCADE
  ON DELETE RESTRICT;

-- (2) is_system implies system_role
ALTER TABLE public.accounts
  ADD CONSTRAINT accounts_is_system_requires_role
  CHECK (is_system IS NOT TRUE OR system_role IS NOT NULL);

-- (3) Trigger guard: only upsert_system_account may write system_role / is_system
CREATE OR REPLACE FUNCTION public.enforce_system_account_helper()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  in_helper text;
  in_teardown text;
BEGIN
  -- Allow during governance teardown (ADR 0019)
  BEGIN
    in_teardown := current_setting('app.reset_in_progress', true);
  EXCEPTION WHEN OTHERS THEN
    in_teardown := NULL;
  END;
  IF in_teardown IS NOT NULL AND in_teardown <> '' THEN
    RETURN NEW;
  END IF;

  -- The canonical helper sets this GUC for the duration of its body.
  BEGIN
    in_helper := current_setting('app.upsert_system_account.in_progress', true);
  EXCEPTION WHEN OTHERS THEN
    in_helper := NULL;
  END;
  IF in_helper = '1' THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.system_role IS NOT NULL OR COALESCE(NEW.is_system, false) = true THEN
      RAISE EXCEPTION
        'system accounts must be provisioned via public.upsert_system_account() — direct INSERT of system_role=% / is_system=% is not allowed',
        NEW.system_role, NEW.is_system
        USING ERRCODE = 'check_violation';
    END IF;
  ELSIF TG_OP = 'UPDATE' THEN
    IF (NEW.system_role IS DISTINCT FROM OLD.system_role)
       OR (COALESCE(NEW.is_system,false) IS DISTINCT FROM COALESCE(OLD.is_system,false)) THEN
      RAISE EXCEPTION
        'system_role / is_system on public.accounts can only be changed via public.upsert_system_account()'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_enforce_system_account_helper ON public.accounts;
CREATE TRIGGER trg_enforce_system_account_helper
BEFORE INSERT OR UPDATE ON public.accounts
FOR EACH ROW EXECUTE FUNCTION public.enforce_system_account_helper();

-- (4) Update upsert_system_account to set the GUC for the duration of its body.
--     We rewrite the body to wrap existing logic with set_config(..., true).
--     This preserves the existing function signature and behaviour.
CREATE OR REPLACE FUNCTION public.upsert_system_account(
  p_business_id uuid,
  p_organization_id uuid,
  p_system_role text,
  p_code text,
  p_name text,
  p_account_type text,
  p_detail_type text DEFAULT NULL,
  p_description text DEFAULT NULL,
  p_parent_id uuid DEFAULT NULL,
  p_currency text DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_account_id uuid;
  v_role_exists boolean;
  v_final_code text := p_code;
  v_code_collision boolean;
BEGIN
  -- Mark this transaction as inside the canonical helper so the
  -- enforce_system_account_helper trigger lets our writes through.
  PERFORM set_config('app.upsert_system_account.in_progress', '1', true);

  -- Validate role
  SELECT EXISTS (SELECT 1 FROM public.system_account_roles WHERE role_key = p_system_role)
    INTO v_role_exists;
  IF NOT v_role_exists THEN
    RAISE EXCEPTION 'unknown system_role: %', p_system_role
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  -- If a row already exists for this (business_id, system_role), return it.
  SELECT id INTO v_account_id
    FROM public.accounts
   WHERE business_id = p_business_id
     AND system_role = p_system_role
   LIMIT 1;
  IF v_account_id IS NOT NULL THEN
    PERFORM set_config('app.upsert_system_account.in_progress', '', true);
    RETURN v_account_id;
  END IF;

  -- Resolve a code collision (someone already has p_code for a non-system row)
  SELECT EXISTS (
    SELECT 1 FROM public.accounts
     WHERE business_id = p_business_id AND code = v_final_code
  ) INTO v_code_collision;
  IF v_code_collision THEN
    v_final_code := v_final_code || '-SYS';
  END IF;

  INSERT INTO public.accounts (
    organization_id, business_id, account_type, detail_type,
    code, name, description, parent_id, currency,
    is_system, system_role, is_active, opening_balance, current_balance
  ) VALUES (
    p_organization_id, p_business_id, p_account_type, p_detail_type,
    v_final_code, p_name, p_description, p_parent_id, p_currency,
    true, p_system_role, true, 0, 0
  )
  RETURNING id INTO v_account_id;

  PERFORM set_config('app.upsert_system_account.in_progress', '', true);
  RETURN v_account_id;
END;
$$;
