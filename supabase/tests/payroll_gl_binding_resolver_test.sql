-- payroll_gl_binding_resolver_test.sql
-- Pins the invariants that make effective-dated GL bindings load-bearing
-- (post-payroll-gl now resolves through resolve_default_account_binding):
--   (1) The resolver + sync trigger + table objects all exist.
--   (2) The sync trigger keeps default_account_settings and the bindings
--       table in lock-step (no divergence) for the open (effective_to IS NULL)
--       row of every payroll-shaped mapping.
--   (3) resolve_default_account_binding honours the org → legal-entity
--       specificity cascade, and — because GL mapping is HQ-authoritative and
--       branches never own accounts — a branch with no binding CASCADES to the
--       shared company/entity default rather than resolving a branch account.
BEGIN;

  -- (1) Structural objects exist.
  DO $$
  BEGIN
    IF to_regclass('public.default_account_setting_bindings') IS NULL THEN
      RAISE EXCEPTION 'default_account_setting_bindings table is missing';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM pg_proc WHERE proname = 'resolve_default_account_binding'
    ) THEN
      RAISE EXCEPTION 'resolve_default_account_binding() is missing';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM pg_trigger
      WHERE tgname = 'trg_default_account_settings_binding_sync'
    ) THEN
      RAISE EXCEPTION 'binding sync trigger is missing — bindings would drift';
    END IF;
  END $$;

  -- (2) Non-divergence: every flat mapping row must have exactly one matching
  --     open binding pointing at the same account for the same scope.
  DO $$
  DECLARE n_drift int;
  BEGIN
    SELECT count(*) INTO n_drift
      FROM public.default_account_settings d
     WHERE NOT EXISTS (
       SELECT 1 FROM public.default_account_setting_bindings b
        WHERE b.organization_id = d.organization_id
          AND b.business_id IS NOT DISTINCT FROM d.business_id
          AND b.branch_id   IS NOT DISTINCT FROM d.branch_id
          AND b.setting_key = d.setting_key
          AND b.account_id  = d.account_id
          AND b.effective_to IS NULL
     );
    IF n_drift > 0 THEN
      RAISE EXCEPTION 'flat/binding divergence: % mapping row(s) have no matching open binding', n_drift;
    END IF;
  END $$;

  -- (3) Specificity cascade — legal-entity (business) wins over org, and a
  --     branch (which never owns an account) CASCADES to the shared default.
  DO $$
  DECLARE
    v_org uuid; v_biz uuid; v_branch uuid;
    v_a_org uuid; v_a_biz uuid;
    v_res uuid;
    v_key text := '__test_binding_key__';
  BEGIN
    SELECT organization_id, id INTO v_org, v_biz FROM public.businesses LIMIT 1;
    IF v_biz IS NULL THEN RAISE NOTICE 'no business; skipping (3)'; RETURN; END IF;

    SELECT id INTO v_branch FROM public.branches
      WHERE organization_id = v_org LIMIT 1;

    -- Need two distinct postable accounts to bind at org and legal-entity scope.
    SELECT id INTO v_a_org FROM public.accounts
      WHERE organization_id = v_org ORDER BY code LIMIT 1;
    SELECT id INTO v_a_biz FROM public.accounts
      WHERE organization_id = v_org AND id <> v_a_org ORDER BY code LIMIT 1;
    IF v_a_org IS NULL OR v_a_biz IS NULL THEN
      RAISE NOTICE 'insufficient accounts; skipping (3)'; RETURN;
    END IF;

    -- Org-level binding.
    INSERT INTO public.default_account_setting_bindings
      (organization_id, business_id, branch_id, setting_key, account_id, source)
    VALUES (v_org, NULL, NULL, v_key, v_a_org, 'manual');

    -- Legal-entity (business) binding.
    INSERT INTO public.default_account_setting_bindings
      (organization_id, business_id, branch_id, setting_key, account_id, source)
    VALUES (v_org, v_biz, NULL, v_key, v_a_biz, 'manual');

    -- Business scope resolves to the business-level account (more specific than org).
    v_res := public.resolve_default_account_binding(v_key, v_org, v_biz, NULL, now());
    IF v_res <> v_a_biz THEN
      RAISE EXCEPTION 'business scope should resolve business binding, got %', v_res;
    END IF;

    -- Org scope (no business) resolves to the org-level account.
    v_res := public.resolve_default_account_binding(v_key, v_org, NULL, NULL, now());
    IF v_res <> v_a_org THEN
      RAISE EXCEPTION 'org scope should resolve org binding, got %', v_res;
    END IF;

    -- HQ-authoritative invariant: a branch has NO branch-scoped account and
    -- must cascade to the shared legal-entity default — never a branch account.
    -- (We deliberately do NOT author a branch binding; branch differentiation
    --  lives on the JE line as a posting dimension, not in the COA mapping.)
    IF v_branch IS NOT NULL THEN
      v_res := public.resolve_default_account_binding(v_key, v_org, v_biz, v_branch, now());
      IF v_res <> v_a_biz THEN
        RAISE EXCEPTION
          'branch must cascade to the shared legal-entity default (%), got %',
          v_a_biz, v_res;
      END IF;
    END IF;
  END $$;

ROLLBACK;
