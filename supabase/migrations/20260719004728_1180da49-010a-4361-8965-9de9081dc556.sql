
-- Wave 3 · Phase 4.d — freeze fx + tip policy on the session aggregate.
ALTER TABLE public.pos_payment_sessions
  ADD COLUMN IF NOT EXISTS fx_rate             numeric,
  ADD COLUMN IF NOT EXISTS settlement_currency text,
  ADD COLUMN IF NOT EXISTS tip_policy          text;

-- Backfill: existing rows keep a 1:1 rate against their own currency so the
-- commit posting stays a no-op for historical sessions.
UPDATE public.pos_payment_sessions
   SET fx_rate             = COALESCE(fx_rate, 1),
       settlement_currency = COALESCE(settlement_currency, currency),
       tip_policy          = COALESCE(tip_policy, 'none')
 WHERE fx_rate IS NULL
    OR settlement_currency IS NULL
    OR tip_policy IS NULL;

-- 10.1 open — extended signature. The old signature stays callable for
-- existing clients (Postgres routes the shorter arg list to the old fn).
CREATE OR REPLACE FUNCTION public.pos_payment_session_open(
  p_register_id         uuid,
  p_grand_total         numeric,
  p_currency            text,
  p_idempotency_key     text,
  p_tip_amount          numeric DEFAULT 0,
  p_cashier_id          uuid    DEFAULT NULL,
  p_fx_rate             numeric DEFAULT 1,
  p_settlement_currency text    DEFAULT NULL,
  p_tip_policy          text    DEFAULT 'none'
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_reg  public.pos_registers%ROWTYPE;
  v_row  public.pos_payment_sessions%ROWTYPE;
BEGIN
  IF p_idempotency_key IS NULL OR length(p_idempotency_key) = 0 THEN
    RAISE EXCEPTION 'pos_payment_session_open: p_idempotency_key is required'
      USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_reg FROM public.pos_registers WHERE id = p_register_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'pos_payment_session_open: unknown register %', p_register_id
      USING ERRCODE = 'no_data_found';
  END IF;

  PERFORM public.assert_pos_caller_branch_access(v_reg.branch_id);

  -- Idempotent replay: return the existing row for the same key. FX +
  -- tip policy are IMMUTABLE for the life of the session, so we do not
  -- refresh them on replay even if the caller passes new values.
  SELECT * INTO v_row
    FROM public.pos_payment_sessions
   WHERE business_id = v_reg.business_id AND idempotency_key = p_idempotency_key;
  IF FOUND THEN
    RETURN v_row.id;
  END IF;

  INSERT INTO public.pos_payment_sessions
    (register_id, cashier_id, business_id, branch_id, organization_id,
     currency, grand_total, tip_amount, idempotency_key, created_by,
     fx_rate, settlement_currency, tip_policy)
  VALUES
    (v_reg.id, p_cashier_id, v_reg.business_id, v_reg.branch_id, v_reg.organization_id,
     COALESCE(p_currency,'KES'), p_grand_total, COALESCE(p_tip_amount,0),
     p_idempotency_key, auth.uid(),
     COALESCE(p_fx_rate, 1),
     COALESCE(p_settlement_currency, p_currency, 'KES'),
     COALESCE(p_tip_policy, 'none'))
  RETURNING * INTO v_row;

  PERFORM public._pos_payment_session_emit(
    'pos.payment.session.opened', v_row,
    jsonb_build_object(
      'session_id', v_row.id,
      'register_id', v_row.register_id,
      'grand_total', v_row.grand_total,
      'currency', v_row.currency,
      'settlement_currency', v_row.settlement_currency,
      'fx_rate', v_row.fx_rate,
      'tip_policy', v_row.tip_policy,
      'idempotency_key', v_row.idempotency_key
    )
  );

  RETURN v_row.id;
END $$;

-- Wave 3 · Phase 4.e — abandonment sweeper.
--
-- Routes through pos_payment_session_cancel so captured card tenders are
-- actually reversed via the FSM — never a raw UPDATE. Returns the number
-- of sessions swept. Callable by service_role only; pg_cron schedules it.
CREATE OR REPLACE FUNCTION public.pos_payment_session_sweep_abandoned(
  p_older_than_minutes int DEFAULT 30
) RETURNS int
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_id     uuid;
  v_count  int := 0;
  v_cutoff timestamptz := now() - make_interval(mins => GREATEST(p_older_than_minutes, 1));
BEGIN
  FOR v_id IN
    SELECT id
      FROM public.pos_payment_sessions
     WHERE status = 'open'
       AND created_at < v_cutoff
     ORDER BY created_at
     LIMIT 500
  LOOP
    BEGIN
      PERFORM public.pos_payment_session_cancel(v_id, 'abandoned');
      v_count := v_count + 1;
    EXCEPTION WHEN OTHERS THEN
      -- Never let one bad session block the sweeper; the cancel RPC
      -- already logs its own failures via the outbox.
      CONTINUE;
    END;
  END LOOP;
  RETURN v_count;
END $$;

REVOKE ALL ON FUNCTION public.pos_payment_session_sweep_abandoned(int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.pos_payment_session_sweep_abandoned(int) TO service_role;
