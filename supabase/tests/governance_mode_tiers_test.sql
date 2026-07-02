-- =========================================================================
-- SoD Wave G4 — runtime invariant test for the three-tier governance_mode
-- =========================================================================
-- Verifies that governance_assert_not_self honours each mode tier
-- (solo / standard / strict) as documented in Wave G3, and that an
-- explicit self_action_policy row always wins over the mode default.
--
-- Pattern mirrors `self_action_guard_test.sql`: synthetic org/business/
-- branch wrapped in a transaction that ROLLBACKs at the end.
-- =========================================================================

BEGIN;

DO $$
DECLARE
  v_org       uuid := gen_random_uuid();
  v_business  uuid := gen_random_uuid();
  v_branch    uuid := gen_random_uuid();
  v_owner     uuid := gen_random_uuid();
  v_admin     uuid := gen_random_uuid();
  v_staff     uuid := gen_random_uuid();
  v_bill      uuid;
  v_caught    boolean;
  v_hint      text;
  v_mode      text;
BEGIN
  -- ---------------------------------------------------------------------
  -- Synthetic skeleton.
  -- ---------------------------------------------------------------------
  INSERT INTO public.organizations (id, name, slug, owner_user_id, governance_mode)
    VALUES (v_org, 'g4-test-org', 'g4-test-' || substr(v_org::text, 1, 8), v_owner, 'solo');

  INSERT INTO public.businesses (id, organization_id, name, owner_user_id)
    VALUES (v_business, v_org, 'g4-test-biz', v_owner);

  INSERT INTO public.branches (id, business_id, organization_id, name, is_default)
    VALUES (v_branch, v_business, v_org, 'HQ', true);

  INSERT INTO public.user_roles (user_id, organization_id, business_id, role, is_active)
    VALUES (v_owner, v_org, v_business, 'owner', true);

  -- ---------------------------------------------------------------------
  -- TIER 1 — solo + 1 member: owner self-approval must succeed.
  -- ---------------------------------------------------------------------
  INSERT INTO public.bills (
    id, organization_id, business_id, branch_id,
    bill_number, bill_date, due_date,
    subtotal, total_amount, status, created_by
  ) VALUES (
    gen_random_uuid(), v_org, v_business, v_branch,
    'G4-SOLO-1', current_date, current_date + 30,
    10, 10, 'draft', v_owner
  ) RETURNING id INTO v_bill;

  UPDATE public.bills
     SET status = 'approved', approved_by = v_owner, approved_at = now()
   WHERE id = v_bill;
  RAISE NOTICE 'OK: solo + 1 member → owner self-approval allowed';

  -- ---------------------------------------------------------------------
  -- TIER 2 — adding a 2nd active member must auto-promote to 'standard'.
  -- ---------------------------------------------------------------------
  INSERT INTO public.user_roles (user_id, organization_id, business_id, role, is_active)
    VALUES (v_admin, v_org, v_business, 'admin', true);

  SELECT governance_mode INTO v_mode FROM public.organizations WHERE id = v_org;
  IF v_mode <> 'standard' THEN
    RAISE EXCEPTION 'FAIL: expected auto-promote to standard, got %', v_mode;
  END IF;
  RAISE NOTICE 'OK: solo → standard auto-promotion on 2nd member';

  INSERT INTO public.user_roles (user_id, organization_id, business_id, role, is_active)
    VALUES (v_staff, v_org, v_business, 'staff', true);

  -- Owner self-approves (warn, allowed).
  INSERT INTO public.bills (
    id, organization_id, business_id, branch_id,
    bill_number, bill_date, due_date,
    subtotal, total_amount, status, created_by
  ) VALUES (
    gen_random_uuid(), v_org, v_business, v_branch,
    'G4-STD-OWNER', current_date, current_date + 30,
    10, 10, 'draft', v_owner
  ) RETURNING id INTO v_bill;
  UPDATE public.bills
     SET status = 'approved', approved_by = v_owner, approved_at = now()
   WHERE id = v_bill;
  RAISE NOTICE 'OK: standard → owner self-approval allowed (warn)';

  -- Staff self-approval must be blocked.
  INSERT INTO public.bills (
    id, organization_id, business_id, branch_id,
    bill_number, bill_date, due_date,
    subtotal, total_amount, status, created_by
  ) VALUES (
    gen_random_uuid(), v_org, v_business, v_branch,
    'G4-STD-STAFF', current_date, current_date + 30,
    10, 10, 'draft', v_staff
  ) RETURNING id INTO v_bill;

  v_caught := false;
  BEGIN
    UPDATE public.bills
       SET status = 'approved', approved_by = v_staff, approved_at = now()
     WHERE id = v_bill;
  EXCEPTION
    WHEN insufficient_privilege THEN
      GET STACKED DIAGNOSTICS v_hint = PG_EXCEPTION_HINT;
      IF v_hint = 'GOV_SELF_ACTION' THEN v_caught := true; END IF;
  END;
  IF NOT v_caught THEN
    RAISE EXCEPTION 'FAIL: standard → staff self-approval was not blocked';
  END IF;
  RAISE NOTICE 'OK: standard → staff self-approval blocked';

  -- ---------------------------------------------------------------------
  -- TIER 3 — strict: even the owner must be blocked.
  -- ---------------------------------------------------------------------
  UPDATE public.organizations SET governance_mode = 'strict' WHERE id = v_org;

  INSERT INTO public.bills (
    id, organization_id, business_id, branch_id,
    bill_number, bill_date, due_date,
    subtotal, total_amount, status, created_by
  ) VALUES (
    gen_random_uuid(), v_org, v_business, v_branch,
    'G4-STRICT-OWNER', current_date, current_date + 30,
    10, 10, 'draft', v_owner
  ) RETURNING id INTO v_bill;

  v_caught := false;
  BEGIN
    UPDATE public.bills
       SET status = 'approved', approved_by = v_owner, approved_at = now()
     WHERE id = v_bill;
  EXCEPTION
    WHEN insufficient_privilege THEN
      GET STACKED DIAGNOSTICS v_hint = PG_EXCEPTION_HINT;
      IF v_hint = 'GOV_SELF_ACTION' THEN v_caught := true; END IF;
  END;
  IF NOT v_caught THEN
    RAISE EXCEPTION 'FAIL: strict → owner self-approval was not blocked';
  END IF;
  RAISE NOTICE 'OK: strict → owner self-approval blocked';

  -- ---------------------------------------------------------------------
  -- Explicit policy row must override the strict default.
  -- ---------------------------------------------------------------------
  INSERT INTO public.self_action_policy (organization_id, action_key, applies_to_role, mode)
    VALUES (v_org, 'bill.approve', 'owner', 'allow');

  INSERT INTO public.bills (
    id, organization_id, business_id, branch_id,
    bill_number, bill_date, due_date,
    subtotal, total_amount, status, created_by
  ) VALUES (
    gen_random_uuid(), v_org, v_business, v_branch,
    'G4-STRICT-OVR', current_date, current_date + 30,
    10, 10, 'draft', v_owner
  ) RETURNING id INTO v_bill;
  UPDATE public.bills
     SET status = 'approved', approved_by = v_owner, approved_at = now()
   WHERE id = v_bill;
  RAISE NOTICE 'OK: strict + explicit allow → owner self-approval allowed';

  -- Staff still blocked because no explicit row matches.
  INSERT INTO public.bills (
    id, organization_id, business_id, branch_id,
    bill_number, bill_date, due_date,
    subtotal, total_amount, status, created_by
  ) VALUES (
    gen_random_uuid(), v_org, v_business, v_branch,
    'G4-STRICT-STAFF', current_date, current_date + 30,
    10, 10, 'draft', v_staff
  ) RETURNING id INTO v_bill;

  v_caught := false;
  BEGIN
    UPDATE public.bills
       SET status = 'approved', approved_by = v_staff, approved_at = now()
     WHERE id = v_bill;
  EXCEPTION
    WHEN insufficient_privilege THEN
      GET STACKED DIAGNOSTICS v_hint = PG_EXCEPTION_HINT;
      IF v_hint = 'GOV_SELF_ACTION' THEN v_caught := true; END IF;
  END;
  IF NOT v_caught THEN
    RAISE EXCEPTION 'FAIL: strict + owner-only allow row → staff was not blocked';
  END IF;
  RAISE NOTICE 'OK: strict + owner-only allow → staff still blocked';

  RAISE NOTICE 'SoD Wave G4 runtime invariants: ALL OK';
END $$;

ROLLBACK;