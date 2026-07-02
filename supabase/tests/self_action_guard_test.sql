-- =========================================================================
-- SoD Wave G2 — runtime invariant test (pgTAP-style, no extension required)
-- =========================================================================
-- Verifies that the self-action framework actually rejects self-approval
-- attempts and that a single-use override succeeds exactly once.
--
-- Pattern: minimal smoke test against a synthetic org/business/branch.
-- All work happens in a transaction that is rolled back at the end so
-- the test never touches real tenant data.
-- =========================================================================

BEGIN;

DO $$
DECLARE
  v_org       uuid := gen_random_uuid();
  v_business  uuid := gen_random_uuid();
  v_branch    uuid := gen_random_uuid();
  v_user_a    uuid := gen_random_uuid();
  v_user_b    uuid := gen_random_uuid();
  v_bill      uuid;
  v_caught    boolean := false;
  v_hint      text;
BEGIN
  -- ---------------------------------------------------------------------
  -- Synthetic tenant skeleton (only the bare minimum the FKs require).
  -- ---------------------------------------------------------------------
  INSERT INTO public.organizations (id, name, slug, owner_user_id)
    VALUES (v_org, 'sod-test-org', 'sod-test-' || substr(v_org::text, 1, 8), v_user_a);

  INSERT INTO public.businesses (id, organization_id, name, owner_user_id)
    VALUES (v_business, v_org, 'sod-test-biz', v_user_a);

  INSERT INTO public.branches (id, business_id, organization_id, name, is_default)
    VALUES (v_branch, v_business, v_org, 'HQ', true);

  -- ---------------------------------------------------------------------
  -- Default policy is `block`. A bill created by user A approved by user A
  -- must be rejected with SQLSTATE 42501 / HINT GOV_SELF_ACTION.
  -- ---------------------------------------------------------------------
  INSERT INTO public.bills (
    id, organization_id, business_id, branch_id,
    bill_number, vendor_id, bill_date, due_date,
    subtotal, total_amount, status, created_by
  ) VALUES (
    gen_random_uuid(), v_org, v_business, v_branch,
    'SOD-TEST-001', NULL, current_date, current_date + 30,
    100, 100, 'draft', v_user_a
  ) RETURNING id INTO v_bill;

  BEGIN
    UPDATE public.bills
       SET status = 'approved',
           approved_by = v_user_a,
           approved_at = now()
     WHERE id = v_bill;
  EXCEPTION
    WHEN insufficient_privilege THEN
      GET STACKED DIAGNOSTICS v_hint = PG_EXCEPTION_HINT;
      IF v_hint = 'GOV_SELF_ACTION' THEN
        v_caught := true;
      ELSE
        RAISE;
      END IF;
  END;

  IF NOT v_caught THEN
    RAISE EXCEPTION 'FAIL: self-approval of bills was not blocked';
  END IF;
  RAISE NOTICE 'OK: bills self-approval rejected with GOV_SELF_ACTION';

  -- ---------------------------------------------------------------------
  -- User B (not the creator) MUST be able to approve.
  -- ---------------------------------------------------------------------
  UPDATE public.bills
     SET status = 'approved',
         approved_by = v_user_b,
         approved_at = now()
   WHERE id = v_bill;
  RAISE NOTICE 'OK: cross-user approval succeeded';

  -- ---------------------------------------------------------------------
  -- Override flow: issue a single-use override for user A on bill.approve,
  -- assert the next self-approval succeeds and consumes the override,
  -- then a second self-approval is rejected again.
  -- ---------------------------------------------------------------------
  INSERT INTO public.bills (
    id, organization_id, business_id, branch_id,
    bill_number, bill_date, due_date,
    subtotal, total_amount, status, created_by
  ) VALUES (
    gen_random_uuid(), v_org, v_business, v_branch,
    'SOD-TEST-002', current_date, current_date + 30,
    50, 50, 'draft', v_user_a
  ) RETURNING id INTO v_bill;

  INSERT INTO public.self_action_overrides (
    organization_id, action_key, actor_user_id, co_signed_by,
    reason, expires_at
  ) VALUES (
    v_org, 'bill.approve', v_user_a, v_user_b,
    'Audit fixture verifying one-shot override consumption.',
    now() + interval '1 hour'
  );

  UPDATE public.bills
     SET status = 'approved',
         approved_by = v_user_a,
         approved_at = now()
   WHERE id = v_bill;
  RAISE NOTICE 'OK: override permitted one self-approval';

  -- A second self-approval should be rejected (override already consumed).
  INSERT INTO public.bills (
    id, organization_id, business_id, branch_id,
    bill_number, bill_date, due_date,
    subtotal, total_amount, status, created_by
  ) VALUES (
    gen_random_uuid(), v_org, v_business, v_branch,
    'SOD-TEST-003', current_date, current_date + 30,
    25, 25, 'draft', v_user_a
  ) RETURNING id INTO v_bill;

  v_caught := false;
  BEGIN
    UPDATE public.bills
       SET status = 'approved',
           approved_by = v_user_a,
           approved_at = now()
     WHERE id = v_bill;
  EXCEPTION
    WHEN insufficient_privilege THEN
      GET STACKED DIAGNOSTICS v_hint = PG_EXCEPTION_HINT;
      IF v_hint = 'GOV_SELF_ACTION' THEN
        v_caught := true;
      END IF;
  END;

  IF NOT v_caught THEN
    RAISE EXCEPTION 'FAIL: override appears to be reusable (single-use contract broken)';
  END IF;
  RAISE NOTICE 'OK: override is single-use; subsequent self-approval blocked';

  RAISE NOTICE 'SoD Wave G2 runtime invariants: ALL OK';
END $$;

ROLLBACK;
