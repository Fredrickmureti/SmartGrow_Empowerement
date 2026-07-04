-- payroll_wet_resolver_test.sql
-- Pins the Work Entry Type resolver contract that the projector,
-- compute-payroll, and every downstream lookup depend on:
--   (1) Function object exists and is STABLE + SECURITY DEFINER.
--   (2) Tenant override for (org, business, code) wins over pack default.
--   (3) Pack default (business_id IS NULL) is returned when no tenant row.
--   (4) Unknown code returns NULL.
--   (5) Regression guard: the pre-Phase-A global (org, code) unique index
--       does NOT exist (its return would break override coexistence again).
--   (6) The correct partial-unique index IS present.
BEGIN;

  -- (1) Resolver function exists with the expected volatility + security.
  DO $$
  BEGIN
    IF NOT EXISTS (
      SELECT 1
        FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public'
         AND p.proname = 'payroll_resolve_wet'
         AND p.provolatile = 's'  -- STABLE
         AND p.prosecdef  = true  -- SECURITY DEFINER
    ) THEN
      RAISE EXCEPTION 'payroll_resolve_wet(uuid, uuid, text) missing or not STABLE SECURITY DEFINER';
    END IF;
  END $$;

  -- (2)-(4) Behavioural: seed pack + tenant rows and verify resolution order.
  DO $$
  DECLARE
    v_org uuid := gen_random_uuid();
    v_biz uuid := gen_random_uuid();
    v_pack_ot uuid;
    v_tenant_ot uuid;
    v_pack_work uuid;
    v_res uuid;
  BEGIN
    -- Fixture: pack default OT + tenant override OT + pack-only WORK.
    INSERT INTO public.payroll_work_entry_types
      (organization_id, business_id, code, name, is_paid, counts_as_worked,
       multiplier_normal, multiplier_overtime, sequence, is_pack_default, is_active)
    VALUES (v_org, NULL, 'OT', 'Overtime (pack)', true, true, 1, 1.5, 20, true, true)
    RETURNING id INTO v_pack_ot;

    INSERT INTO public.payroll_work_entry_types
      (organization_id, business_id, code, name, is_paid, counts_as_worked,
       multiplier_normal, multiplier_overtime, sequence, is_pack_default, is_active)
    VALUES (v_org, v_biz, 'OT', 'Overtime (tenant override)', true, true, 1, 2, 20, false, true)
    RETURNING id INTO v_tenant_ot;

    INSERT INTO public.payroll_work_entry_types
      (organization_id, business_id, code, name, is_paid, counts_as_worked,
       multiplier_normal, multiplier_overtime, sequence, is_pack_default, is_active)
    VALUES (v_org, NULL, 'WORK', 'Regular work (pack)', true, true, 1, 1, 10, true, true)
    RETURNING id INTO v_pack_work;

    -- Tenant override wins.
    v_res := public.payroll_resolve_wet(v_org, v_biz, 'OT');
    IF v_res IS DISTINCT FROM v_tenant_ot THEN
      RAISE EXCEPTION 'resolver should prefer tenant override for (org, business, OT); got %, expected %', v_res, v_tenant_ot;
    END IF;

    -- No tenant row for WORK: pack default is returned.
    v_res := public.payroll_resolve_wet(v_org, v_biz, 'WORK');
    IF v_res IS DISTINCT FROM v_pack_work THEN
      RAISE EXCEPTION 'resolver should return pack default for WORK; got %, expected %', v_res, v_pack_work;
    END IF;

    -- Passing NULL business scope falls through to the pack default.
    v_res := public.payroll_resolve_wet(v_org, NULL, 'OT');
    IF v_res IS DISTINCT FROM v_pack_ot THEN
      RAISE EXCEPTION 'resolver with NULL business must return pack default; got %, expected %', v_res, v_pack_ot;
    END IF;

    -- Unknown code -> NULL.
    v_res := public.payroll_resolve_wet(v_org, v_biz, 'DOES_NOT_EXIST');
    IF v_res IS NOT NULL THEN
      RAISE EXCEPTION 'resolver should return NULL for unknown code; got %', v_res;
    END IF;
  END $$;

  -- (5) Regression guard — the pre-Phase-A over-strict unique index is gone.
  DO $$
  BEGIN
    IF EXISTS (
      SELECT 1 FROM pg_indexes
       WHERE schemaname = 'public'
         AND indexname  = 'payroll_work_entry_types_org_code_uidx'
    ) THEN
      RAISE EXCEPTION 'payroll_work_entry_types_org_code_uidx has been re-added — pack + tenant overrides will 409 again';
    END IF;
  END $$;

  -- (6) The correct partial-unique index that lets pack + tenant coexist
  --     must exist. Its definition sentinels NULL business_id to a fixed UUID.
  DO $$
  BEGIN
    IF NOT EXISTS (
      SELECT 1 FROM pg_indexes
       WHERE schemaname = 'public'
         AND indexname  = 'uq_work_entry_types_business_code'
    ) THEN
      RAISE EXCEPTION 'uq_work_entry_types_business_code missing — override uniqueness is unenforced';
    END IF;
  END $$;

ROLLBACK;
