-- =====================================================================
-- POS Stage B3 — server-side branch-mutation authority
-- =====================================================================

-- 1) Caller-authority helper. Allows system/service calls (auth.uid() NULL).
CREATE OR REPLACE FUNCTION public.assert_pos_caller_branch_access(p_branch_id uuid)
RETURNS void
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
BEGIN
  -- System / service-role contexts (no JWT) bypass: triggers fired from
  -- SECURITY DEFINER RPCs still see the original auth.uid(), so this only
  -- exempts true service-role calls and migrations.
  IF v_uid IS NULL THEN
    RETURN;
  END IF;

  IF p_branch_id IS NULL THEN
    -- A NULL branch on a branch-bearing POS row is suspicious; let the
    -- branch-business consistency trigger handle company-shared cases.
    RETURN;
  END IF;

  IF NOT public.user_can_access_branch(v_uid, p_branch_id) THEN
    RAISE EXCEPTION 'POS branch isolation: user % is not authorised to mutate rows scoped to branch %', v_uid, p_branch_id
      USING ERRCODE = '42501'; -- insufficient_privilege
  END IF;
END;
$$;

COMMENT ON FUNCTION public.assert_pos_caller_branch_access(uuid) IS
  'POS Stage B3: caller-authority guard. Used by per-table triggers to ensure '
  'the JWT subject can write to the target branch. service_role / auth.uid()=NULL bypass.';

-- 2) Generic trigger function: pull effective branch from NEW.branch_id or
--    (for child rows) the parent register's branch_id.
CREATE OR REPLACE FUNCTION public.tg_assert_pos_branch_caller_access()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_branch_id uuid;
  v_register_id uuid;
BEGIN
  -- Prefer the row's own branch_id if present and non-null
  BEGIN
    v_branch_id := (to_jsonb(NEW) ->> 'branch_id')::uuid;
  EXCEPTION WHEN others THEN
    v_branch_id := NULL;
  END;

  IF v_branch_id IS NULL THEN
    -- Fallback to parent register, when this table has register_id
    BEGIN
      v_register_id := (to_jsonb(NEW) ->> 'register_id')::uuid;
    EXCEPTION WHEN others THEN
      v_register_id := NULL;
    END;
    IF v_register_id IS NOT NULL THEN
      SELECT branch_id INTO v_branch_id FROM public.pos_registers WHERE id = v_register_id;
    END IF;
  END IF;

  PERFORM public.assert_pos_caller_branch_access(v_branch_id);
  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.tg_assert_pos_branch_caller_access() IS
  'POS Stage B3: generic BEFORE-trigger that delegates to assert_pos_caller_branch_access.';

-- 3) Attach to every POS table that carries a branch boundary. Named with
--    a `zzz_` prefix so they run AFTER existing BEFORE triggers (e.g. the
--    stamp_branch_from_register trigger that fills NEW.branch_id from the
--    parent register on INSERT). PG fires BEFORE triggers alphabetically.

DO $$
DECLARE
  t text;
BEGIN
  FOR t IN
    SELECT unnest(ARRAY[
      'pos_shifts',
      'pos_sessions',
      'pos_cashiers',
      'pos_kitchen_orders',
      'pos_table_bookings',
      'pos_waitlist'
    ])
  LOOP
    EXECUTE format(
      'DROP TRIGGER IF EXISTS zzz_assert_pos_branch_caller_access ON public.%I', t
    );
    EXECUTE format(
      'CREATE TRIGGER zzz_assert_pos_branch_caller_access
         BEFORE INSERT OR UPDATE ON public.%I
         FOR EACH ROW EXECUTE FUNCTION public.tg_assert_pos_branch_caller_access()', t
    );
  END LOOP;
END $$;

-- 4) pos_payment_methods has a special rule: company-default rows
--    (branch_id IS NULL) may only be written by org/business admins,
--    branch-scoped rows require branch access.

CREATE OR REPLACE FUNCTION public.tg_assert_pos_payment_method_scope()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
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
  SELECT EXISTS (
    SELECT 1
    FROM public.user_organizations uo
    WHERE uo.user_id = v_uid
      AND uo.organization_id = NEW.organization_id
      AND uo.role IN ('owner','admin','super_admin')
  )
  INTO v_is_admin;

  IF NOT COALESCE(v_is_admin, false) THEN
    RAISE EXCEPTION 'POS payment-method company default may only be edited by an organization admin (user %)', v_uid
      USING ERRCODE = '42501';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS zzz_assert_pos_payment_method_scope ON public.pos_payment_methods;
CREATE TRIGGER zzz_assert_pos_payment_method_scope
  BEFORE INSERT OR UPDATE ON public.pos_payment_methods
  FOR EACH ROW EXECUTE FUNCTION public.tg_assert_pos_payment_method_scope();
