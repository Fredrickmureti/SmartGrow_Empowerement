-- Locks the fraction-form invariant on garnishment policy percentages.
-- If either check disappears the payroll engine's org-floor / aggregate-cap
-- math silently blows up (see docs/audit — Kenya-pack percent-form regression).

BEGIN;

DO $$
DECLARE
  v_bad int;
BEGIN
  SELECT count(*) INTO v_bad
    FROM public.localization_pack_garnishment_policies
   WHERE (aggregate_cap_pct IS NOT NULL AND (aggregate_cap_pct < 0 OR aggregate_cap_pct > 1))
      OR (min_take_home_pct IS NOT NULL AND (min_take_home_pct < 0 OR min_take_home_pct > 1));
  IF v_bad > 0 THEN
    RAISE EXCEPTION 'localization_pack_garnishment_policies has % row(s) with pct outside [0,1]', v_bad;
  END IF;

  SELECT count(*) INTO v_bad
    FROM public.payroll_settings
   WHERE (garnishment_aggregate_cap_pct IS NOT NULL AND (garnishment_aggregate_cap_pct < 0 OR garnishment_aggregate_cap_pct > 1))
      OR (garnishment_minimum_take_home_pct IS NOT NULL AND (garnishment_minimum_take_home_pct < 0 OR garnishment_minimum_take_home_pct > 1));
  IF v_bad > 0 THEN
    RAISE EXCEPTION 'payroll_settings has % row(s) with garnishment pct outside [0,1]', v_bad;
  END IF;

  PERFORM 1 FROM pg_constraint
    WHERE conname = 'chk_pack_garn_policy_aggregate_cap_pct_fraction';
  IF NOT FOUND THEN RAISE EXCEPTION 'chk_pack_garn_policy_aggregate_cap_pct_fraction missing'; END IF;

  PERFORM 1 FROM pg_constraint
    WHERE conname = 'chk_pack_garn_policy_min_take_home_pct_fraction';
  IF NOT FOUND THEN RAISE EXCEPTION 'chk_pack_garn_policy_min_take_home_pct_fraction missing'; END IF;

  PERFORM 1 FROM pg_constraint
    WHERE conname = 'chk_payroll_settings_garn_aggregate_cap_pct_fraction';
  IF NOT FOUND THEN RAISE EXCEPTION 'chk_payroll_settings_garn_aggregate_cap_pct_fraction missing'; END IF;

  PERFORM 1 FROM pg_constraint
    WHERE conname = 'chk_payroll_settings_garn_min_take_home_pct_fraction';
  IF NOT FOUND THEN RAISE EXCEPTION 'chk_payroll_settings_garn_min_take_home_pct_fraction missing'; END IF;
END $$;

-- Constraint actually rejects percent-form writes.
DO $$
DECLARE v_pack_id uuid; v_rejected boolean := false;
BEGIN
  SELECT id INTO v_pack_id FROM public.localization_packs LIMIT 1;
  IF v_pack_id IS NULL THEN RETURN; END IF;
  BEGIN
    INSERT INTO public.localization_pack_garnishment_policies
      (pack_id, policy_key, aggregate_cap_pct, min_take_home_pct)
      VALUES (v_pack_id, '__frac_probe__', 66.6667, 33.3333);
  EXCEPTION WHEN check_violation THEN
    v_rejected := true;
  END;
  IF NOT v_rejected THEN
    RAISE EXCEPTION 'CHECK constraint failed to reject percent-form policy insert';
  END IF;
END $$;

ROLLBACK;
