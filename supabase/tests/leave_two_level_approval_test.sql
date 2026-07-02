-- C-HR-3: Two-level leave approval — schema, RPC, and guard regression.
-- Verifies the columns, status state, and helper function exist with the
-- intended shape. Behavioural authorization is covered by the application
-- tests that exercise the RPC under different roles.

BEGIN;

-- leave_types config columns
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='leave_types'
      AND column_name='requires_second_approval'
  ) THEN
    RAISE EXCEPTION 'leave_types.requires_second_approval is missing';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='leave_types'
      AND column_name='second_approval_threshold_days'
  ) THEN
    RAISE EXCEPTION 'leave_types.second_approval_threshold_days is missing';
  END IF;
END $$;

-- status check constraint must include 'pending_second_approval'
DO $$
DECLARE
  v_def text;
BEGIN
  SELECT pg_get_constraintdef(con.oid) INTO v_def
  FROM pg_constraint con
  JOIN pg_class r ON r.oid = con.conrelid
  JOIN pg_namespace n ON n.oid = r.relnamespace
  WHERE n.nspname='public' AND r.relname='leave_requests'
    AND con.conname='leave_requests_status_check';

  IF v_def IS NULL THEN
    RAISE EXCEPTION 'leave_requests_status_check constraint is missing';
  END IF;

  IF v_def NOT LIKE '%pending_second_approval%' THEN
    RAISE EXCEPTION 'leave_requests_status_check must allow pending_second_approval; got: %', v_def;
  END IF;
END $$;

-- both RPCs must exist and be SECURITY DEFINER
DO $$
DECLARE
  v_secdef boolean;
BEGIN
  SELECT prosecdef INTO v_secdef FROM pg_proc
  WHERE proname='approve_leave_request_level1' AND pronamespace='public'::regnamespace;
  IF v_secdef IS NULL THEN
    RAISE EXCEPTION 'approve_leave_request_level1 RPC is missing';
  END IF;
  IF NOT v_secdef THEN
    RAISE EXCEPTION 'approve_leave_request_level1 must be SECURITY DEFINER';
  END IF;

  SELECT prosecdef INTO v_secdef FROM pg_proc
  WHERE proname='approve_leave_request_level2' AND pronamespace='public'::regnamespace;
  IF v_secdef IS NULL THEN
    RAISE EXCEPTION 'approve_leave_request_level2 RPC is missing';
  END IF;
  IF NOT v_secdef THEN
    RAISE EXCEPTION 'approve_leave_request_level2 must be SECURITY DEFINER';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_proc
    WHERE proname='user_can_approve_leave_level2' AND pronamespace='public'::regnamespace
  ) THEN
    RAISE EXCEPTION 'user_can_approve_leave_level2 helper is missing';
  END IF;
END $$;

ROLLBACK;
