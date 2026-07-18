
-- Wave 2 · Phase C-1 — Card/EMV FSM substrate for pos_transaction_payments.
-- Defines the canonical state machine and idempotent RPCs; UI controller lands next.

-- Allowed transitions map (source of truth for the transition trigger).
CREATE TABLE IF NOT EXISTS public.pos_card_fsm_transitions (
  from_state text NOT NULL,
  to_state   text NOT NULL,
  PRIMARY KEY (from_state, to_state)
);

GRANT SELECT ON public.pos_card_fsm_transitions TO authenticated;
GRANT ALL    ON public.pos_card_fsm_transitions TO service_role;
ALTER TABLE public.pos_card_fsm_transitions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "fsm map is readable to authenticated" ON public.pos_card_fsm_transitions;
CREATE POLICY "fsm map is readable to authenticated"
  ON public.pos_card_fsm_transitions FOR SELECT TO authenticated USING (true);

INSERT INTO public.pos_card_fsm_transitions(from_state, to_state) VALUES
  ('idle','collecting'),
  ('collecting','authorizing'),
  ('collecting','failed'),
  ('authorizing','approved'),
  ('authorizing','declined'),
  ('authorizing','failed'),
  ('approved','captured'),
  ('approved','voided'),
  ('approved','failed'),
  ('captured','refunded'),
  ('declined','idle'),
  ('failed','idle')
ON CONFLICT DO NOTHING;

-- Transition guard trigger.
CREATE OR REPLACE FUNCTION public.pos_card_fsm_guard()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF NEW.tender_kind IS DISTINCT FROM 'card' THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.auth_state IS NOT NULL
       AND NEW.auth_state NOT IN ('idle','collecting','authorizing','approved','captured') THEN
      RAISE EXCEPTION 'pos_card_fsm_guard: illegal initial auth_state=%', NEW.auth_state;
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.auth_state IS DISTINCT FROM NEW.auth_state
     AND NEW.auth_state IS NOT NULL
     AND OLD.auth_state IS NOT NULL
     AND NOT EXISTS (
       SELECT 1 FROM public.pos_card_fsm_transitions
        WHERE from_state = OLD.auth_state AND to_state = NEW.auth_state
     ) THEN
    RAISE EXCEPTION 'pos_card_fsm_guard: illegal transition % -> %',
      OLD.auth_state, NEW.auth_state;
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_pos_card_fsm_guard ON public.pos_transaction_payments;
CREATE TRIGGER trg_pos_card_fsm_guard
  BEFORE INSERT OR UPDATE OF auth_state ON public.pos_transaction_payments
  FOR EACH ROW EXECUTE FUNCTION public.pos_card_fsm_guard();

-- Idempotent RPCs (keyed by vendor_txn_id / auth_id so retries never double-book).

CREATE OR REPLACE FUNCTION public.pos_card_authorize(
  p_payment_id      uuid,
  p_authorized      numeric,
  p_auth_id         text,
  p_vendor_txn_id   text,
  p_card_last_four  text DEFAULT NULL,
  p_card_type       text DEFAULT NULL
) RETURNS public.pos_transaction_payments
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE r public.pos_transaction_payments;
BEGIN
  SELECT * INTO r FROM public.pos_transaction_payments WHERE id = p_payment_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'payment % not found', p_payment_id; END IF;
  IF r.tender_kind <> 'card' THEN RAISE EXCEPTION 'not a card tender'; END IF;
  -- Idempotency: same auth for same vendor_txn returns the current row unchanged.
  IF r.auth_state = 'approved' AND r.vendor_txn_id = p_vendor_txn_id THEN RETURN r; END IF;
  IF r.auth_state NOT IN ('idle','collecting','authorizing') THEN
    RAISE EXCEPTION 'authorize illegal from state %', r.auth_state;
  END IF;
  UPDATE public.pos_transaction_payments SET
    auth_state         = 'approved',
    auth_id            = p_auth_id,
    vendor_txn_id      = p_vendor_txn_id,
    authorized_amount  = p_authorized,
    card_last_four     = COALESCE(p_card_last_four, card_last_four),
    card_type          = COALESCE(p_card_type, card_type),
    processed_at       = COALESCE(processed_at, now())
  WHERE id = p_payment_id
  RETURNING * INTO r;
  RETURN r;
END $$;

CREATE OR REPLACE FUNCTION public.pos_card_capture(
  p_payment_id uuid,
  p_amount     numeric
) RETURNS public.pos_transaction_payments
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE r public.pos_transaction_payments;
BEGIN
  SELECT * INTO r FROM public.pos_transaction_payments WHERE id = p_payment_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'payment % not found', p_payment_id; END IF;
  IF r.auth_state = 'captured' THEN RETURN r; END IF; -- idempotent
  IF r.auth_state <> 'approved' THEN
    RAISE EXCEPTION 'capture illegal from state %', r.auth_state;
  END IF;
  IF p_amount > COALESCE(r.authorized_amount, r.amount) + 0.005 THEN
    RAISE EXCEPTION 'capture % exceeds authorized %', p_amount, r.authorized_amount;
  END IF;
  UPDATE public.pos_transaction_payments SET
    auth_state = 'captured',
    amount     = p_amount,
    status     = 'completed',
    processed_at = now()
  WHERE id = p_payment_id
  RETURNING * INTO r;
  RETURN r;
END $$;

CREATE OR REPLACE FUNCTION public.pos_card_void(
  p_payment_id uuid,
  p_reason     text DEFAULT NULL
) RETURNS public.pos_transaction_payments
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE r public.pos_transaction_payments;
BEGIN
  SELECT * INTO r FROM public.pos_transaction_payments WHERE id = p_payment_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'payment % not found', p_payment_id; END IF;
  IF r.auth_state = 'voided' THEN RETURN r; END IF; -- idempotent
  IF r.auth_state <> 'approved' THEN
    RAISE EXCEPTION 'void illegal from state % (only pre-capture voids)', r.auth_state;
  END IF;
  UPDATE public.pos_transaction_payments SET
    auth_state = 'voided',
    status     = 'failed',
    reference  = COALESCE(reference,'') ||
                 CASE WHEN p_reason IS NULL THEN '' ELSE ' void:'||p_reason END
  WHERE id = p_payment_id
  RETURNING * INTO r;
  RETURN r;
END $$;

CREATE OR REPLACE FUNCTION public.pos_card_reverse(
  p_payment_id uuid,
  p_reason     text DEFAULT NULL
) RETURNS public.pos_transaction_payments
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE r public.pos_transaction_payments;
BEGIN
  SELECT * INTO r FROM public.pos_transaction_payments WHERE id = p_payment_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'payment % not found', p_payment_id; END IF;
  IF r.auth_state = 'refunded' THEN RETURN r; END IF; -- idempotent
  IF r.auth_state <> 'captured' THEN
    RAISE EXCEPTION 'reverse illegal from state % (needs capture first)', r.auth_state;
  END IF;
  UPDATE public.pos_transaction_payments SET
    auth_state = 'refunded',
    status     = 'refunded',
    reference  = COALESCE(reference,'') ||
                 CASE WHEN p_reason IS NULL THEN '' ELSE ' reverse:'||p_reason END
  WHERE id = p_payment_id
  RETURNING * INTO r;
  RETURN r;
END $$;

REVOKE ALL ON FUNCTION public.pos_card_authorize(uuid,numeric,text,text,text,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.pos_card_capture(uuid,numeric) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.pos_card_void(uuid,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.pos_card_reverse(uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.pos_card_authorize(uuid,numeric,text,text,text,text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.pos_card_capture(uuid,numeric) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.pos_card_void(uuid,text)   TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.pos_card_reverse(uuid,text) TO authenticated, service_role;
