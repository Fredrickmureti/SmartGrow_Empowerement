
-- POS Stage R1 — close the remaining branch-isolation gaps
-- Adds branch_id where missing, attaches the Stage B caller-authority
-- trigger to every operational/financial POS surface still uncovered.

-- ---------------------------------------------------------------
-- 1) Schema: add branch_id where missing (nullable = company-shared)
-- ---------------------------------------------------------------
ALTER TABLE public.pos_floors      ADD COLUMN IF NOT EXISTS branch_id uuid REFERENCES public.branches(id) ON DELETE RESTRICT;
ALTER TABLE public.pos_gift_cards  ADD COLUMN IF NOT EXISTS branch_id uuid REFERENCES public.branches(id) ON DELETE RESTRICT;
ALTER TABLE public.pos_discounts   ADD COLUMN IF NOT EXISTS branch_id uuid REFERENCES public.branches(id) ON DELETE RESTRICT;
ALTER TABLE public.pos_cashier_registers ADD COLUMN IF NOT EXISTS branch_id uuid REFERENCES public.branches(id) ON DELETE RESTRICT;

-- Backfill pos_floors.branch_id from register_id where present
UPDATE public.pos_floors f
   SET branch_id = r.branch_id
  FROM public.pos_registers r
 WHERE f.register_id = r.id
   AND f.branch_id IS NULL;

-- Backfill pos_cashier_registers.branch_id from register_id
UPDATE public.pos_cashier_registers cr
   SET branch_id = r.branch_id
  FROM public.pos_registers r
 WHERE cr.register_id = r.id
   AND cr.branch_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_pos_floors_branch       ON public.pos_floors(branch_id);
CREATE INDEX IF NOT EXISTS idx_pos_gift_cards_branch   ON public.pos_gift_cards(branch_id);
CREATE INDEX IF NOT EXISTS idx_pos_discounts_branch    ON public.pos_discounts(branch_id);
CREATE INDEX IF NOT EXISTS idx_pos_cashier_registers_branch ON public.pos_cashier_registers(branch_id);

-- ---------------------------------------------------------------
-- 2) Stamp branch_id on pos_cashier_registers from register
-- ---------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.tg_stamp_pos_cashier_registers_branch()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.branch_id IS NULL AND NEW.register_id IS NOT NULL THEN
    SELECT branch_id INTO NEW.branch_id FROM public.pos_registers WHERE id = NEW.register_id;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS aaa_stamp_pos_cashier_registers_branch ON public.pos_cashier_registers;
CREATE TRIGGER aaa_stamp_pos_cashier_registers_branch
  BEFORE INSERT OR UPDATE ON public.pos_cashier_registers
  FOR EACH ROW EXECUTE FUNCTION public.tg_stamp_pos_cashier_registers_branch();

-- ---------------------------------------------------------------
-- 3) Stamp pos_floors.branch_id from register_id when present
-- ---------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.tg_stamp_pos_floors_branch()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.branch_id IS NULL AND NEW.register_id IS NOT NULL THEN
    SELECT branch_id INTO NEW.branch_id FROM public.pos_registers WHERE id = NEW.register_id;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS aaa_stamp_pos_floors_branch ON public.pos_floors;
CREATE TRIGGER aaa_stamp_pos_floors_branch
  BEFORE INSERT OR UPDATE ON public.pos_floors
  FOR EACH ROW EXECUTE FUNCTION public.tg_stamp_pos_floors_branch();

-- ---------------------------------------------------------------
-- 4) Caller-authority "scope" guard for company-shared tables
--    (gift cards, discounts) — mirrors the pos_payment_methods rule:
--      branch_id IS NULL → org/business admin only
--      branch_id NOT NULL → caller must have access to that branch
-- ---------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.tg_assert_pos_scope_caller_access()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
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

  -- Company-shared row: require org/business admin
  SELECT EXISTS (
    SELECT 1 FROM public.user_organizations uo
    WHERE uo.user_id = v_uid
      AND uo.organization_id = v_org
      AND uo.role IN ('owner','admin','super_admin')
  ) INTO v_is_admin;

  IF NOT COALESCE(v_is_admin, false) THEN
    RAISE EXCEPTION 'POS company-shared row may only be edited by an organization admin (user %)', v_uid
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;

-- ---------------------------------------------------------------
-- 5) Attach Stage B caller-authority triggers to missed surfaces
-- ---------------------------------------------------------------
DO $$
DECLARE t text;
BEGIN
  -- Tables where branch_id is required (NOT NULL semantics or always present via register)
  FOR t IN SELECT unnest(ARRAY[
    'pos_held_transactions',
    'pos_table_sessions',
    'pos_cashier_registers',
    'pos_floors'
  ])
  LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS zzz_assert_pos_branch_caller_access ON public.%I', t);
    EXECUTE format(
      'CREATE TRIGGER zzz_assert_pos_branch_caller_access
         BEFORE INSERT OR UPDATE ON public.%I
         FOR EACH ROW EXECUTE FUNCTION public.tg_assert_pos_branch_caller_access()', t);
  END LOOP;

  -- Tables with company-shared semantics (branch_id nullable)
  FOR t IN SELECT unnest(ARRAY['pos_gift_cards','pos_discounts'])
  LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS zzz_assert_pos_scope_caller_access ON public.%I', t);
    EXECUTE format(
      'CREATE TRIGGER zzz_assert_pos_scope_caller_access
         BEFORE INSERT OR UPDATE ON public.%I
         FOR EACH ROW EXECUTE FUNCTION public.tg_assert_pos_scope_caller_access()', t);
  END LOOP;
END $$;
