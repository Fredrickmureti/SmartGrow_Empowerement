
-- Stage D: held-order recall hardening + idempotency documentation

-- 1. Partial index for fast "what's held for this shift" lookups
CREATE INDEX IF NOT EXISTS idx_pos_held_transactions_active_by_shift
  ON public.pos_held_transactions (shift_id, held_at DESC)
  WHERE status = 'held';

-- 2. Recall RPC — same-shift, open-shift only
CREATE OR REPLACE FUNCTION public.recall_pos_held_transaction(
  p_held_id uuid,
  p_shift_id uuid
)
RETURNS public.pos_held_transactions
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_held public.pos_held_transactions;
  v_shift_status text;
  v_shift_register uuid;
BEGIN
  IF p_held_id IS NULL OR p_shift_id IS NULL THEN
    RAISE EXCEPTION 'held_id and shift_id are required' USING ERRCODE = 'invalid_parameter_value';
  END IF;

  -- Lock the held row to prevent concurrent recalls
  SELECT * INTO v_held FROM public.pos_held_transactions
  WHERE id = p_held_id FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'held_order_not_found' USING ERRCODE = 'no_data_found';
  END IF;

  -- Visibility / RLS check via business scope
  IF NOT public.user_can_access_business(auth.uid(), v_held.business_id) THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF v_held.status <> 'held' THEN
    RAISE EXCEPTION 'held_order_already_%', v_held.status
      USING ERRCODE = 'invalid_parameter_value',
            DETAIL = 'held_order_not_recallable';
  END IF;

  -- Same-shift guard: held order must be recalled into the shift it was held in
  IF v_held.shift_id IS DISTINCT FROM p_shift_id THEN
    RAISE EXCEPTION 'shift_mismatch'
      USING ERRCODE = 'invalid_parameter_value',
            DETAIL  = 'held_order_belongs_to_other_shift';
  END IF;

  -- Target shift must be open
  SELECT status, register_id INTO v_shift_status, v_shift_register
  FROM public.pos_shifts WHERE id = p_shift_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'shift_not_found' USING ERRCODE = 'no_data_found';
  END IF;

  IF v_shift_status <> 'open' THEN
    RAISE EXCEPTION 'shift_not_open_for_recall'
      USING ERRCODE = 'invalid_parameter_value',
            DETAIL  = format('shift_status=%s', v_shift_status);
  END IF;

  -- Mark recalled
  UPDATE public.pos_held_transactions
     SET status = 'resumed',
         updated_at = now()
   WHERE id = p_held_id
   RETURNING * INTO v_held;

  RETURN v_held;
END;
$$;

REVOKE ALL ON FUNCTION public.recall_pos_held_transaction(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.recall_pos_held_transaction(uuid, uuid) TO authenticated;

COMMENT ON FUNCTION public.recall_pos_held_transaction(uuid, uuid) IS
  'Stage D: recall a held POS order into the same open shift it was held in. '
  'Rejects cross-shift recall (shift_mismatch), closed-shift recall (shift_not_open_for_recall), '
  'and double-recall (held_order_already_*).';

-- 3. Idempotency documentation on the existing commit RPC + index
COMMENT ON INDEX public.pos_transactions_idempotency_key_uidx IS
  'Stage D commit-idempotency surface. Combined with process_pos_transaction.p_idempotency_key, '
  'enables safe retry of a single logical sale: a duplicate commit with the same key returns the '
  'existing transaction id rather than creating a second row. Clients MUST pass a deterministic '
  'key for the lifetime of one logical commit attempt and only rotate after a successful return.';

-- 4. Assertion: confirm sentinels survived the migration
DO $$
DECLARE
  v_body text;
BEGIN
  SELECT prosrc INTO v_body FROM pg_proc p JOIN pg_namespace n ON p.pronamespace = n.oid
  WHERE n.nspname = 'public' AND p.proname = 'recall_pos_held_transaction';

  IF v_body IS NULL
     OR v_body NOT LIKE '%shift_mismatch%'
     OR v_body NOT LIKE '%shift_not_open_for_recall%'
     OR v_body NOT LIKE '%held_order_not_found%' THEN
    RAISE EXCEPTION 'recall_pos_held_transaction missing required sentinels';
  END IF;
END;
$$;
