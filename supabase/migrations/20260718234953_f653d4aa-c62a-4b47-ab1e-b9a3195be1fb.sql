
-- =============================================================================
-- Wave 3 · Phase 1 — POS Payment Sessions (durable payment-in-progress aggregate)
-- =============================================================================

-- ---------- 1. Enums --------------------------------------------------------

DO $$ BEGIN
  CREATE TYPE public.pos_payment_session_status AS ENUM
    ('open','balanced','committed','cancelled','abandoned');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE public.pos_payment_session_tender_state AS ENUM
    ('idle','authorizing','approved','captured','reversed','failed');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ---------- 2. Tables -------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.pos_payment_sessions (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pos_transaction_id  uuid NULL,
  register_id         uuid NOT NULL,
  cashier_id          uuid NULL,
  business_id         uuid NOT NULL,
  branch_id           uuid NULL,
  organization_id     uuid NULL,
  currency            text NOT NULL DEFAULT 'KES',
  grand_total         numeric(18,4) NOT NULL CHECK (grand_total >= 0),
  tip_amount          numeric(18,4) NOT NULL DEFAULT 0 CHECK (tip_amount >= 0),
  status              public.pos_payment_session_status NOT NULL DEFAULT 'open',
  idempotency_key     text NOT NULL,
  opened_at           timestamptz NOT NULL DEFAULT now(),
  closed_at           timestamptz NULL,
  closed_reason       text NULL,
  created_by          uuid NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pos_payment_sessions_idem_unique UNIQUE (business_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS idx_pos_payment_sessions_register_status
  ON public.pos_payment_sessions (register_id, status);
CREATE INDEX IF NOT EXISTS idx_pos_payment_sessions_branch
  ON public.pos_payment_sessions (branch_id);
CREATE INDEX IF NOT EXISTS idx_pos_payment_sessions_txn
  ON public.pos_payment_sessions (pos_transaction_id);

CREATE TABLE IF NOT EXISTS public.pos_payment_session_tenders (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id          uuid NOT NULL REFERENCES public.pos_payment_sessions(id) ON DELETE CASCADE,
  business_id         uuid NOT NULL,
  branch_id           uuid NULL,
  tender_kind         text NOT NULL,
  method_key          text NOT NULL,
  provider_key        text NULL,
  amount              numeric(18,4) NOT NULL CHECK (amount >= 0),
  tendered_amount     numeric(18,4) NOT NULL DEFAULT 0 CHECK (tendered_amount >= 0),
  change_given        numeric(18,4) NOT NULL DEFAULT 0 CHECK (change_given >= 0),
  reference           text NULL,
  auth_state          public.pos_payment_session_tender_state NOT NULL DEFAULT 'idle',
  auth_id             text NULL,
  vendor_txn_id       text NULL,
  driver_payload      jsonb NOT NULL DEFAULT '{}'::jsonb,
  reversed_at         timestamptz NULL,
  reversal_reason     text NULL,
  idempotency_key     text NOT NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pos_payment_session_tenders_idem_unique UNIQUE (session_id, idempotency_key),
  CONSTRAINT pos_payment_session_tenders_change_only_when_tendered
    CHECK (change_given = 0 OR tendered_amount >= amount + change_given - 0.0001)
);

CREATE INDEX IF NOT EXISTS idx_pos_payment_session_tenders_session
  ON public.pos_payment_session_tenders (session_id);

CREATE TABLE IF NOT EXISTS public.pos_payment_session_apply_log (
  session_id      uuid PRIMARY KEY REFERENCES public.pos_payment_sessions(id) ON DELETE CASCADE,
  transaction_id  uuid NULL,
  applied_at      timestamptz NOT NULL DEFAULT now(),
  applied_by      uuid NULL
);

-- ---------- 3. Grants (public schema is not auto-granted) -------------------

GRANT SELECT ON public.pos_payment_sessions          TO authenticated;
GRANT ALL    ON public.pos_payment_sessions          TO service_role;

GRANT SELECT ON public.pos_payment_session_tenders   TO authenticated;
GRANT ALL    ON public.pos_payment_session_tenders   TO service_role;

GRANT SELECT ON public.pos_payment_session_apply_log TO authenticated;
GRANT ALL    ON public.pos_payment_session_apply_log TO service_role;

-- ---------- 4. Row-level security (RPC-only write surface) ------------------

ALTER TABLE public.pos_payment_sessions          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pos_payment_session_tenders   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pos_payment_session_apply_log ENABLE ROW LEVEL SECURITY;

-- Sessions: read scoped to the caller's branch access.
DROP POLICY IF EXISTS pos_payment_sessions_select ON public.pos_payment_sessions;
CREATE POLICY pos_payment_sessions_select
  ON public.pos_payment_sessions
  FOR SELECT TO authenticated
  USING (
    branch_id IS NULL
    OR public.user_can_access_branch(auth.uid(), branch_id)
  );

DROP POLICY IF EXISTS pos_payment_session_tenders_select ON public.pos_payment_session_tenders;
CREATE POLICY pos_payment_session_tenders_select
  ON public.pos_payment_session_tenders
  FOR SELECT TO authenticated
  USING (
    branch_id IS NULL
    OR public.user_can_access_branch(auth.uid(), branch_id)
  );

DROP POLICY IF EXISTS pos_payment_session_apply_log_select ON public.pos_payment_session_apply_log;
CREATE POLICY pos_payment_session_apply_log_select
  ON public.pos_payment_session_apply_log
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.pos_payment_sessions s
      WHERE s.id = pos_payment_session_apply_log.session_id
        AND (s.branch_id IS NULL OR public.user_can_access_branch(auth.uid(), s.branch_id))
    )
  );

-- Intentionally NO insert/update/delete policies for `authenticated`.
-- All writes flow through SECURITY DEFINER RPCs below.

-- ---------- 5. Branch-scope trigger (matches locked pos_branch_isolation_test) --

DROP TRIGGER IF EXISTS zzz_assert_pos_branch_caller_access ON public.pos_payment_sessions;
CREATE TRIGGER zzz_assert_pos_branch_caller_access
  BEFORE INSERT OR UPDATE OR DELETE ON public.pos_payment_sessions
  FOR EACH ROW EXECUTE FUNCTION public.tg_assert_pos_branch_caller_access();

DROP TRIGGER IF EXISTS zzz_assert_pos_branch_caller_access ON public.pos_payment_session_tenders;
CREATE TRIGGER zzz_assert_pos_branch_caller_access
  BEFORE INSERT OR UPDATE OR DELETE ON public.pos_payment_session_tenders
  FOR EACH ROW EXECUTE FUNCTION public.tg_assert_pos_branch_caller_access();

-- ---------- 6. FSM guard trigger for tender auth-state transitions ----------

CREATE OR REPLACE FUNCTION public.tg_assert_pos_payment_session_tender_transition()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  ok boolean := false;
BEGIN
  IF TG_OP = 'INSERT' THEN
    -- New rows may enter at idle / authorizing / approved / captured (cash lane).
    IF NEW.auth_state IN ('idle','authorizing','approved','captured') THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'pos_payment_session_tenders: illegal initial auth_state %', NEW.auth_state
      USING ERRCODE = 'check_violation';
  END IF;

  IF OLD.auth_state = NEW.auth_state THEN
    RETURN NEW;
  END IF;

  ok := CASE OLD.auth_state
    WHEN 'idle'        THEN NEW.auth_state IN ('authorizing','approved','captured','failed')
    WHEN 'authorizing' THEN NEW.auth_state IN ('approved','failed','reversed')
    WHEN 'approved'    THEN NEW.auth_state IN ('captured','reversed','failed')
    WHEN 'captured'    THEN NEW.auth_state IN ('reversed')
    WHEN 'reversed'    THEN false
    WHEN 'failed'      THEN false
    ELSE false
  END;

  IF NOT ok THEN
    RAISE EXCEPTION 'pos_payment_session_tenders: illegal FSM transition % -> %',
      OLD.auth_state, NEW.auth_state
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS zzz_assert_tender_fsm ON public.pos_payment_session_tenders;
CREATE TRIGGER zzz_assert_tender_fsm
  BEFORE INSERT OR UPDATE ON public.pos_payment_session_tenders
  FOR EACH ROW EXECUTE FUNCTION public.tg_assert_pos_payment_session_tender_transition();

-- ---------- 7. updated_at maintenance --------------------------------------

CREATE OR REPLACE FUNCTION public.tg_pos_payment_sessions_touch()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at := now(); RETURN NEW; END $$;

DROP TRIGGER IF EXISTS touch_pos_payment_sessions ON public.pos_payment_sessions;
CREATE TRIGGER touch_pos_payment_sessions
  BEFORE UPDATE ON public.pos_payment_sessions
  FOR EACH ROW EXECUTE FUNCTION public.tg_pos_payment_sessions_touch();

DROP TRIGGER IF EXISTS touch_pos_payment_session_tenders ON public.pos_payment_session_tenders;
CREATE TRIGGER touch_pos_payment_session_tenders
  BEFORE UPDATE ON public.pos_payment_session_tenders
  FOR EACH ROW EXECUTE FUNCTION public.tg_pos_payment_sessions_touch();

-- ---------- 8. Outbox topic registration -----------------------------------

INSERT INTO public.business_event_topics
  (topic_prefix, producer_domain, consumer_domains, handler_scope, description)
VALUES
  ('pos.payment.session.opened',    'pos', ARRAY['analytics','audit'],                            'server',
   'A payment session was opened for a POS sale.'),
  ('pos.payment.tender.recorded',   'pos', ARRAY['finance','analytics','audit'],                  'server',
   'A tender was captured against an open payment session (pre-commit).'),
  ('pos.payment.tender.reversed',   'pos', ARRAY['finance','analytics','audit'],                  'server',
   'A previously captured tender was reversed inside an open payment session.'),
  ('pos.payment.session.committed', 'pos', ARRAY['finance','inventory','analytics','crm','audit'],'server',
   'A payment session balanced and its tenders were linked to a sale.'),
  ('pos.payment.session.cancelled', 'pos', ARRAY['finance','analytics','audit'],                  'server',
   'A payment session was cancelled and all captured tenders reversed.')
ON CONFLICT (topic_prefix) DO NOTHING;

-- ---------- 9. Helpers -----------------------------------------------------

-- Sum of live (non-reversed / non-failed) tender amounts on a session.
CREATE OR REPLACE FUNCTION public.pos_payment_session_allocated(p_session_id uuid)
RETURNS numeric
LANGUAGE sql STABLE AS $$
  SELECT COALESCE(SUM(amount), 0)
    FROM public.pos_payment_session_tenders
   WHERE session_id = p_session_id
     AND auth_state NOT IN ('reversed','failed');
$$;

CREATE OR REPLACE FUNCTION public._pos_payment_session_emit(
  p_topic text, p_session public.pos_payment_sessions, p_payload jsonb
) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO public.business_event_outbox
    (org_id, branch_id, event_type, source_doc_type, source_doc_id, payload, idempotency_key, actor_user_id, source)
  VALUES
    (p_session.organization_id, p_session.branch_id, p_topic,
     'pos_payment_session', p_session.id, p_payload,
     p_topic || ':' || p_session.id::text || ':' || COALESCE((p_payload->>'idempotency_key'), gen_random_uuid()::text),
     auth.uid(), 'pos_payment_session_rpc');
END $$;

-- ---------- 10. RPCs -------------------------------------------------------

-- 10.1 open ------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.pos_payment_session_open(
  p_register_id      uuid,
  p_grand_total      numeric,
  p_currency         text,
  p_idempotency_key  text,
  p_tip_amount       numeric DEFAULT 0,
  p_cashier_id       uuid    DEFAULT NULL
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

  -- Idempotent replay: return the existing row for the same key.
  SELECT * INTO v_row
    FROM public.pos_payment_sessions
   WHERE business_id = v_reg.business_id AND idempotency_key = p_idempotency_key;
  IF FOUND THEN
    RETURN v_row.id;
  END IF;

  INSERT INTO public.pos_payment_sessions
    (register_id, cashier_id, business_id, branch_id, organization_id,
     currency, grand_total, tip_amount, idempotency_key, created_by)
  VALUES
    (v_reg.id, p_cashier_id, v_reg.business_id, v_reg.branch_id, v_reg.organization_id,
     COALESCE(p_currency,'KES'), p_grand_total, COALESCE(p_tip_amount,0),
     p_idempotency_key, auth.uid())
  RETURNING * INTO v_row;

  PERFORM public._pos_payment_session_emit(
    'pos.payment.session.opened', v_row,
    jsonb_build_object(
      'session_id', v_row.id,
      'register_id', v_row.register_id,
      'grand_total', v_row.grand_total,
      'currency', v_row.currency,
      'idempotency_key', v_row.idempotency_key
    )
  );

  RETURN v_row.id;
END $$;

-- 10.2 record_tender ---------------------------------------------------------
CREATE OR REPLACE FUNCTION public.pos_payment_session_record_tender(
  p_session_id       uuid,
  p_tender           jsonb,
  p_idempotency_key  text
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_session   public.pos_payment_sessions%ROWTYPE;
  v_existing  public.pos_payment_session_tenders%ROWTYPE;
  v_row       public.pos_payment_session_tenders%ROWTYPE;
  v_allocated numeric;
  v_amount    numeric;
BEGIN
  IF p_idempotency_key IS NULL OR length(p_idempotency_key) = 0 THEN
    RAISE EXCEPTION 'pos_payment_session_record_tender: p_idempotency_key is required'
      USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_session FROM public.pos_payment_sessions WHERE id = p_session_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'pos_payment_session_record_tender: unknown session %', p_session_id
      USING ERRCODE = 'no_data_found';
  END IF;

  PERFORM public.assert_pos_caller_branch_access(v_session.branch_id);

  IF v_session.status NOT IN ('open','balanced') THEN
    RAISE EXCEPTION 'pos_payment_session_record_tender: session % is %', p_session_id, v_session.status
      USING ERRCODE = 'check_violation';
  END IF;

  -- Idempotent replay
  SELECT * INTO v_existing
    FROM public.pos_payment_session_tenders
   WHERE session_id = p_session_id AND idempotency_key = p_idempotency_key;
  IF FOUND THEN
    RETURN v_existing.id;
  END IF;

  v_amount := (p_tender->>'amount')::numeric;
  IF v_amount IS NULL OR v_amount < 0 THEN
    RAISE EXCEPTION 'pos_payment_session_record_tender: invalid amount'
      USING ERRCODE = 'check_violation';
  END IF;

  -- Reject over-allocation (grand_total + tip, no overtender cap in phase 1
  -- beyond cash change; cash rows carry change_given so `amount` still
  -- represents value applied to the invoice, which must not exceed the total).
  v_allocated := public.pos_payment_session_allocated(p_session_id);
  IF v_allocated + v_amount > (v_session.grand_total + v_session.tip_amount) + 0.0001 THEN
    RAISE EXCEPTION 'pos_payment_session_record_tender: over-allocation (% + % > %)',
      v_allocated, v_amount, v_session.grand_total + v_session.tip_amount
      USING ERRCODE = 'check_violation';
  END IF;

  INSERT INTO public.pos_payment_session_tenders
    (session_id, business_id, branch_id,
     tender_kind, method_key, provider_key,
     amount, tendered_amount, change_given, reference,
     auth_state, auth_id, vendor_txn_id, driver_payload, idempotency_key)
  VALUES
    (v_session.id, v_session.business_id, v_session.branch_id,
     COALESCE(p_tender->>'tender_kind','cash'),
     COALESCE(p_tender->>'method_key','cash'),
     p_tender->>'provider_key',
     v_amount,
     COALESCE((p_tender->>'tendered_amount')::numeric, v_amount),
     COALESCE((p_tender->>'change_given')::numeric, 0),
     p_tender->>'reference',
     COALESCE((p_tender->>'auth_state')::public.pos_payment_session_tender_state, 'captured'),
     p_tender->>'auth_id',
     p_tender->>'vendor_txn_id',
     COALESCE(p_tender->'driver_payload', '{}'::jsonb),
     p_idempotency_key)
  RETURNING * INTO v_row;

  -- Recompute balanced flag.
  IF (public.pos_payment_session_allocated(v_session.id)) >= (v_session.grand_total + v_session.tip_amount) - 0.0001 THEN
    UPDATE public.pos_payment_sessions SET status = 'balanced' WHERE id = v_session.id AND status = 'open';
  END IF;

  PERFORM public._pos_payment_session_emit(
    'pos.payment.tender.recorded', v_session,
    jsonb_build_object('session_id', v_session.id, 'tender_id', v_row.id,
                       'tender_kind', v_row.tender_kind, 'amount', v_row.amount,
                       'idempotency_key', p_idempotency_key)
  );

  RETURN v_row.id;
END $$;

-- 10.3 reverse_tender --------------------------------------------------------
CREATE OR REPLACE FUNCTION public.pos_payment_session_reverse_tender(
  p_session_id  uuid,
  p_tender_id   uuid,
  p_reason      text
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_session public.pos_payment_sessions%ROWTYPE;
  v_tender  public.pos_payment_session_tenders%ROWTYPE;
BEGIN
  SELECT * INTO v_session FROM public.pos_payment_sessions WHERE id = p_session_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'pos_payment_session_reverse_tender: unknown session %', p_session_id
      USING ERRCODE = 'no_data_found';
  END IF;

  PERFORM public.assert_pos_caller_branch_access(v_session.branch_id);

  IF v_session.status IN ('committed','cancelled') THEN
    RAISE EXCEPTION 'pos_payment_session_reverse_tender: session % is %', p_session_id, v_session.status
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT * INTO v_tender
    FROM public.pos_payment_session_tenders
   WHERE id = p_tender_id AND session_id = p_session_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'pos_payment_session_reverse_tender: unknown tender %', p_tender_id
      USING ERRCODE = 'no_data_found';
  END IF;

  IF v_tender.auth_state = 'reversed' THEN
    RETURN;
  END IF;

  UPDATE public.pos_payment_session_tenders
     SET auth_state      = 'reversed',
         reversed_at     = now(),
         reversal_reason = p_reason
   WHERE id = p_tender_id;

  -- Recompute balanced/open flag.
  IF (public.pos_payment_session_allocated(v_session.id)) < (v_session.grand_total + v_session.tip_amount) - 0.0001 THEN
    UPDATE public.pos_payment_sessions SET status = 'open' WHERE id = v_session.id AND status = 'balanced';
  END IF;

  PERFORM public._pos_payment_session_emit(
    'pos.payment.tender.reversed', v_session,
    jsonb_build_object('session_id', v_session.id, 'tender_id', p_tender_id,
                       'reason', p_reason, 'idempotency_key', p_tender_id::text || ':reverse')
  );
END $$;

-- 10.4 commit ----------------------------------------------------------------
-- Accepts the same envelope the client would pass to `process_pos_transaction`
-- MINUS `p_payments` — the tender rows on the session are the payments.
CREATE OR REPLACE FUNCTION public.pos_payment_session_commit(
  p_session_id            uuid,
  p_transaction_envelope  jsonb
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_session       public.pos_payment_sessions%ROWTYPE;
  v_apply         public.pos_payment_session_apply_log%ROWTYPE;
  v_payments      jsonb;
  v_txn_id        uuid;
  v_allocated     numeric;
BEGIN
  SELECT * INTO v_session FROM public.pos_payment_sessions WHERE id = p_session_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'pos_payment_session_commit: unknown session %', p_session_id
      USING ERRCODE = 'no_data_found';
  END IF;

  PERFORM public.assert_pos_caller_branch_access(v_session.branch_id);

  -- Idempotent replay
  SELECT * INTO v_apply FROM public.pos_payment_session_apply_log WHERE session_id = p_session_id;
  IF FOUND THEN
    RETURN v_apply.transaction_id;
  END IF;

  IF v_session.status IN ('cancelled','abandoned') THEN
    RAISE EXCEPTION 'pos_payment_session_commit: session % is %', p_session_id, v_session.status
      USING ERRCODE = 'check_violation';
  END IF;

  v_allocated := public.pos_payment_session_allocated(p_session_id);
  IF v_allocated < (v_session.grand_total + v_session.tip_amount) - 0.0001 THEN
    RAISE EXCEPTION 'pos_payment_session_commit: session % not balanced (% of %)',
      p_session_id, v_allocated, v_session.grand_total + v_session.tip_amount
      USING ERRCODE = 'check_violation';
  END IF;

  -- Materialise session tenders into the p_payments jsonb array expected by
  -- process_pos_transaction. Preserves tendered_amount / change_given per ADR-0009.
  SELECT jsonb_agg(jsonb_build_object(
    'method',           t.method_key,
    'tender_kind',      t.tender_kind,
    'amount',           t.amount,
    'tendered_amount',  t.tendered_amount,
    'change_given',     t.change_given,
    'reference',        t.reference,
    'auth_state',       t.auth_state::text,
    'auth_id',          t.auth_id,
    'vendor_txn_id',    t.vendor_txn_id
  ))
    INTO v_payments
    FROM public.pos_payment_session_tenders t
   WHERE t.session_id = p_session_id
     AND t.auth_state NOT IN ('reversed','failed');

  -- Delegate the transaction+ledger commit to the canonical RPC.
  SELECT public.process_pos_transaction(
    p_organization_id        := (p_transaction_envelope->>'organization_id')::uuid,
    p_business_id            := v_session.business_id,
    p_register_id            := v_session.register_id,
    p_shift_id               := (p_transaction_envelope->>'shift_id')::uuid,
    p_items                  := p_transaction_envelope->'items',
    p_payments               := v_payments,
    p_subtotal               := (p_transaction_envelope->>'subtotal')::numeric,
    p_tax_amount             := (p_transaction_envelope->>'tax_amount')::numeric,
    p_discount_amount        := COALESCE((p_transaction_envelope->>'discount_amount')::numeric, 0),
    p_total                  := v_session.grand_total,
    p_transaction_type       := COALESCE(p_transaction_envelope->>'transaction_type','sale'),
    p_customer_id            := (p_transaction_envelope->>'customer_id')::uuid,
    p_customer_tin           := p_transaction_envelope->>'customer_tin',
    p_customer_name          := p_transaction_envelope->>'customer_name',
    p_notes                  := p_transaction_envelope->>'notes',
    p_cashier_id             := v_session.cashier_id,
    p_created_by             := auth.uid(),
    p_original_transaction_id:= (p_transaction_envelope->>'original_transaction_id')::uuid,
    p_tip_amount             := v_session.tip_amount,
    p_table_session_id       := (p_transaction_envelope->>'table_session_id')::uuid,
    p_idempotency_key        := v_session.idempotency_key
  ) INTO v_txn_id;

  UPDATE public.pos_payment_sessions
     SET status             = 'committed',
         pos_transaction_id = v_txn_id,
         closed_at          = now()
   WHERE id = p_session_id;

  -- Apply-log is the last write so a rollback leaves no ghost log row.
  INSERT INTO public.pos_payment_session_apply_log (session_id, transaction_id, applied_by)
  VALUES (p_session_id, v_txn_id, auth.uid());

  PERFORM public._pos_payment_session_emit(
    'pos.payment.session.committed',
    (SELECT s FROM public.pos_payment_sessions s WHERE s.id = p_session_id),
    jsonb_build_object('session_id', p_session_id, 'transaction_id', v_txn_id,
                       'idempotency_key', v_session.idempotency_key)
  );

  RETURN v_txn_id;
END $$;

-- 10.5 cancel ----------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.pos_payment_session_cancel(
  p_session_id uuid,
  p_reason     text
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_session public.pos_payment_sessions%ROWTYPE;
BEGIN
  SELECT * INTO v_session FROM public.pos_payment_sessions WHERE id = p_session_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'pos_payment_session_cancel: unknown session %', p_session_id
      USING ERRCODE = 'no_data_found';
  END IF;

  PERFORM public.assert_pos_caller_branch_access(v_session.branch_id);

  IF v_session.status = 'committed' THEN
    RAISE EXCEPTION 'pos_payment_session_cancel: session % already committed', p_session_id
      USING ERRCODE = 'check_violation';
  END IF;

  IF v_session.status = 'cancelled' THEN
    RETURN;
  END IF;

  UPDATE public.pos_payment_session_tenders
     SET auth_state      = 'reversed',
         reversed_at     = now(),
         reversal_reason = COALESCE(reversal_reason, p_reason)
   WHERE session_id = p_session_id
     AND auth_state NOT IN ('reversed','failed');

  UPDATE public.pos_payment_sessions
     SET status        = 'cancelled',
         closed_at     = now(),
         closed_reason = p_reason
   WHERE id = p_session_id;

  PERFORM public._pos_payment_session_emit(
    'pos.payment.session.cancelled',
    (SELECT s FROM public.pos_payment_sessions s WHERE s.id = p_session_id),
    jsonb_build_object('session_id', p_session_id, 'reason', p_reason,
                       'idempotency_key', p_session_id::text || ':cancel')
  );
END $$;

-- ---------- 11. Grants on RPCs (authenticated may call; SECURITY DEFINER) --

REVOKE ALL ON FUNCTION public.pos_payment_session_open(uuid,numeric,text,text,numeric,uuid)         FROM PUBLIC;
REVOKE ALL ON FUNCTION public.pos_payment_session_record_tender(uuid,jsonb,text)                    FROM PUBLIC;
REVOKE ALL ON FUNCTION public.pos_payment_session_reverse_tender(uuid,uuid,text)                    FROM PUBLIC;
REVOKE ALL ON FUNCTION public.pos_payment_session_commit(uuid,jsonb)                                FROM PUBLIC;
REVOKE ALL ON FUNCTION public.pos_payment_session_cancel(uuid,text)                                 FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.pos_payment_session_open(uuid,numeric,text,text,numeric,uuid)      TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.pos_payment_session_record_tender(uuid,jsonb,text)                 TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.pos_payment_session_reverse_tender(uuid,uuid,text)                 TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.pos_payment_session_commit(uuid,jsonb)                             TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.pos_payment_session_cancel(uuid,text)                              TO authenticated, service_role;
