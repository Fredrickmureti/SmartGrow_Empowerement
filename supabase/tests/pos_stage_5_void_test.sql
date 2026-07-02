-- Stage 5 closeout — SQL self-tests for process_pos_void v2.
-- Asserts schema + signature stability. End-to-end behavioural assertions
-- live in src/test/pos/stage-5-void.test.ts.

-- 1) Enum value present.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_type t
    JOIN pg_enum e ON e.enumtypid = t.oid
    WHERE t.typname = 'pos_reversal_type' AND e.enumlabel = 'void_post_payment'
  ) THEN
    RAISE EXCEPTION 'pos_reversal_type missing void_post_payment';
  END IF;
END $$;

-- 2) pos_void_reasons exists with seeded rows.
DO $$
DECLARE v_count int;
BEGIN
  SELECT count(*) INTO v_count FROM public.pos_void_reasons;
  IF v_count < 1 THEN
    RAISE EXCEPTION 'pos_void_reasons has no seeded rows (got %)', v_count;
  END IF;
END $$;

-- 3) Threshold column on pos_security_settings.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name   = 'pos_security_settings'
      AND column_name  = 'void_requires_manager_above_amount'
  ) THEN
    RAISE EXCEPTION 'pos_security_settings missing void_requires_manager_above_amount';
  END IF;
END $$;

-- 4) RPC signature includes the new params.
DO $$
DECLARE v_args text;
BEGIN
  SELECT pg_get_function_identity_arguments('public.process_pos_void'::regproc) INTO v_args;
  IF position('p_void_reason_id uuid' IN v_args) = 0 THEN
    RAISE EXCEPTION 'process_pos_void missing p_void_reason_id: %', v_args;
  END IF;
  IF position('p_override_id uuid' IN v_args) = 0 THEN
    RAISE EXCEPTION 'process_pos_void missing p_override_id: %', v_args;
  END IF;
END $$;

-- 5) RLS on pos_void_reasons: read open to authenticated, mutate restricted.
DO $$
DECLARE v_count int;
BEGIN
  SELECT count(*) INTO v_count
  FROM pg_policy
  WHERE polrelid = 'public.pos_void_reasons'::regclass;
  IF v_count < 2 THEN
    RAISE EXCEPTION 'pos_void_reasons RLS policy count too low: %', v_count;
  END IF;
END $$;