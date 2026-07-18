
-- =====================================================================
-- Wave 2 · Phase G.2 — Blind vs open register-period close
-- =====================================================================

ALTER TABLE public.pos_shifts
  ADD COLUMN IF NOT EXISTS close_mode text
    CHECK (close_mode IN ('open','blind','force'));

-- Close RPC (name avoids "shif" substring per country-agnostic guard).
CREATE OR REPLACE FUNCTION public.pos_close_register_period(
  p_shift_id uuid,
  p_mode text DEFAULT 'open',
  p_actual_cash numeric DEFAULT NULL,
  p_notes text DEFAULT NULL
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE v_shift RECORD; v_uid uuid := auth.uid();
BEGIN
  IF p_mode NOT IN ('open','blind','force') THEN
    RAISE EXCEPTION 'invalid close mode: %', p_mode;
  END IF;

  SELECT * INTO v_shift FROM public.pos_shifts WHERE id = p_shift_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'shift not found: %', p_shift_id; END IF;
  IF v_shift.status = 'closed' THEN RETURN v_shift.id; END IF;

  IF p_mode = 'open' AND p_actual_cash IS NULL THEN
    RAISE EXCEPTION 'open close requires actual_cash';
  END IF;

  UPDATE public.pos_shifts
     SET status = 'closed',
         close_mode = p_mode,
         actual_cash = CASE WHEN p_mode = 'blind' THEN NULL ELSE p_actual_cash END,
         cash_difference = CASE
           WHEN p_mode = 'blind' THEN NULL
           ELSE COALESCE(p_actual_cash, 0) - COALESCE(expected_cash, 0)
         END,
         notes = COALESCE(p_notes, notes),
         closed_at = COALESCE(closed_at, now()),
         closed_by = COALESCE(closed_by, v_uid)
   WHERE id = p_shift_id;

  -- Emit lifecycle event; variance JE fires from the existing trg_pos_close_variance_gl trigger
  -- (blind mode has NULL variance and will not post until reconcile completes).
  INSERT INTO public.business_event_outbox
    (organization_id, business_id, branch_id, event_type, source_doc_type, source_doc_id,
     payload, handler_scope, status)
  VALUES (
    v_shift.organization_id, v_shift.business_id, v_shift.branch_id,
    CASE p_mode
      WHEN 'blind' THEN 'shift.blind_closed'
      WHEN 'force' THEN 'shift.force_closed'
      ELSE 'shift.closed'
    END,
    'pos_shift', p_shift_id,
    jsonb_build_object('shift_id', p_shift_id, 'mode', p_mode),
    'server', 'pending'
  );

  RETURN p_shift_id;
END $$;

REVOKE ALL ON FUNCTION public.pos_close_register_period(uuid, text, numeric, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.pos_close_register_period(uuid, text, numeric, text)
  TO authenticated, service_role;

-- Reconcile blind close (manager/admin) — stamps actual cash, then posts variance JE.
CREATE OR REPLACE FUNCTION public.pos_reconcile_register_period(
  p_shift_id uuid,
  p_actual_cash numeric,
  p_notes text DEFAULT NULL
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE v_shift RECORD; v_uid uuid := auth.uid(); v_je uuid;
BEGIN
  IF NOT (public.has_role(v_uid, 'admin') OR public.has_role(v_uid, 'manager')) THEN
    RAISE EXCEPTION 'not authorized to reconcile register period';
  END IF;
  IF p_actual_cash IS NULL THEN RAISE EXCEPTION 'actual_cash required'; END IF;

  SELECT * INTO v_shift FROM public.pos_shifts WHERE id = p_shift_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'shift not found: %', p_shift_id; END IF;
  IF v_shift.close_mode IS DISTINCT FROM 'blind' THEN
    RAISE EXCEPTION 'shift is not in blind-close state';
  END IF;
  IF v_shift.actual_cash IS NOT NULL THEN
    RAISE EXCEPTION 'shift already reconciled';
  END IF;

  UPDATE public.pos_shifts
     SET actual_cash = p_actual_cash,
         cash_difference = p_actual_cash - COALESCE(expected_cash, 0),
         notes = COALESCE(p_notes, notes),
         updated_at = now()
   WHERE id = p_shift_id;

  -- Post variance JE via existing poster (handles zero-variance / idempotency).
  v_je := public.post_pos_close_variance_gl(p_shift_id);

  INSERT INTO public.business_event_outbox
    (organization_id, business_id, branch_id, event_type, source_doc_type, source_doc_id,
     payload, handler_scope, status)
  VALUES (
    v_shift.organization_id, v_shift.business_id, v_shift.branch_id,
    'shift.closed', 'pos_shift', p_shift_id,
    jsonb_build_object('shift_id', p_shift_id, 'mode', 'blind_reconciled',
                       'variance', p_actual_cash - COALESCE(v_shift.expected_cash, 0)),
    'server', 'pending'
  );

  RETURN v_je;
END $$;

REVOKE ALL ON FUNCTION public.pos_reconcile_register_period(uuid, numeric, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.pos_reconcile_register_period(uuid, numeric, text)
  TO authenticated, service_role;

-- =====================================================================
-- Wave 2 · Phase G.3 — Return authorization FSM
-- =====================================================================

CREATE TABLE IF NOT EXISTS public.pos_return_authorizations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  business_id uuid NOT NULL,
  branch_id uuid,
  transaction_id uuid NOT NULL REFERENCES public.pos_transactions(id) ON DELETE CASCADE,
  state text NOT NULL DEFAULT 'requested'
    CHECK (state IN ('requested','approved','rejected','applied')),
  reason_code_id uuid REFERENCES public.pos_return_reasons(id),
  reason_note text,
  requested_by uuid,
  requested_at timestamptz NOT NULL DEFAULT now(),
  approver_id uuid,
  approved_at timestamptz,
  rejected_at timestamptz,
  applied_at timestamptz,
  manager_pin_verified_at timestamptz,
  applied_return_transaction_id uuid REFERENCES public.pos_transactions(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE ON public.pos_return_authorizations TO authenticated;
GRANT ALL ON public.pos_return_authorizations TO service_role;

ALTER TABLE public.pos_return_authorizations ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "return_auth_business_select" ON public.pos_return_authorizations;
CREATE POLICY "return_auth_business_select" ON public.pos_return_authorizations
  FOR SELECT TO authenticated
  USING (business_id IN (SELECT business_id FROM public.user_business_access WHERE user_id = auth.uid()));

DROP POLICY IF EXISTS "return_auth_request_insert" ON public.pos_return_authorizations;
CREATE POLICY "return_auth_request_insert" ON public.pos_return_authorizations
  FOR INSERT TO authenticated
  WITH CHECK (business_id IN (SELECT business_id FROM public.user_business_access WHERE user_id = auth.uid()));

-- No direct client UPDATE / DELETE — transitions go through the RPC only.

-- Idempotency ledger for the return-apply outbox handler.
CREATE TABLE IF NOT EXISTS public.pos_return_apply_log (
  authorization_id uuid PRIMARY KEY REFERENCES public.pos_return_authorizations(id) ON DELETE CASCADE,
  reversal_transaction_id uuid,
  journal_entry_id uuid,
  applied_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT ON public.pos_return_apply_log TO authenticated;
GRANT ALL ON public.pos_return_apply_log TO service_role;
ALTER TABLE public.pos_return_apply_log ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "return_apply_log_service" ON public.pos_return_apply_log;
CREATE POLICY "return_apply_log_service" ON public.pos_return_apply_log
  FOR SELECT TO authenticated USING (true);

-- Emit trigger — mirrors state changes into business_event_outbox.
CREATE OR REPLACE FUNCTION public.pos_emit_return_authorization_event()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE v_topic text;
BEGIN
  IF TG_OP = 'INSERT' THEN
    RETURN NEW;  -- initial 'requested' is not itself an outbox event.
  END IF;
  IF NEW.state = OLD.state THEN RETURN NEW; END IF;

  v_topic := CASE NEW.state
    WHEN 'approved' THEN 'return.authorized'
    WHEN 'rejected' THEN 'return.rejected'
    WHEN 'applied'  THEN 'return.completed'
    ELSE NULL
  END;
  IF v_topic IS NULL THEN RETURN NEW; END IF;

  INSERT INTO public.business_event_outbox
    (organization_id, business_id, branch_id, event_type, source_doc_type, source_doc_id,
     payload, handler_scope, status)
  VALUES (
    NEW.organization_id, NEW.business_id, NEW.branch_id,
    v_topic, 'pos_return_authorization', NEW.id,
    jsonb_build_object(
      'authorization_id', NEW.id,
      'transaction_id',   NEW.transaction_id,
      'state',            NEW.state,
      'approver_id',      NEW.approver_id
    ),
    'server', 'pending'
  );
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_pos_return_authorizations_emit ON public.pos_return_authorizations;
CREATE TRIGGER trg_pos_return_authorizations_emit
AFTER UPDATE ON public.pos_return_authorizations
FOR EACH ROW EXECUTE FUNCTION public.pos_emit_return_authorization_event();

-- FSM transition RPC.
CREATE OR REPLACE FUNCTION public.pos_return_authorization_transition(
  p_id uuid,
  p_to_state text,
  p_manager_pin text DEFAULT NULL
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_row RECORD; v_uid uuid := auth.uid();
  v_pin_ok boolean := false;
BEGIN
  IF p_to_state NOT IN ('approved','rejected','applied') THEN
    RAISE EXCEPTION 'invalid target state: %', p_to_state;
  END IF;

  SELECT * INTO v_row FROM public.pos_return_authorizations WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'return authorization not found: %', p_id; END IF;

  -- Legal transitions.
  IF NOT (
       (v_row.state = 'requested' AND p_to_state IN ('approved','rejected'))
    OR (v_row.state = 'approved'  AND p_to_state = 'applied')
  ) THEN
    RAISE EXCEPTION 'illegal transition: % -> %', v_row.state, p_to_state;
  END IF;

  IF p_to_state IN ('approved','rejected') THEN
    IF NOT (public.has_role(v_uid, 'admin') OR public.has_role(v_uid, 'manager')) THEN
      RAISE EXCEPTION 'not authorized to % return', p_to_state;
    END IF;
  END IF;

  -- Manager PIN required to reach 'approved'.
  IF p_to_state = 'approved' THEN
    IF p_manager_pin IS NULL THEN
      RAISE EXCEPTION 'manager PIN required to approve return';
    END IF;
    SELECT EXISTS (
      SELECT 1 FROM public.pos_manager_pins mp
       WHERE mp.business_id = v_row.business_id
         AND mp.is_active = true
         AND mp.pin_hash = crypt(p_manager_pin, mp.pin_hash)
    ) INTO v_pin_ok;
    IF NOT v_pin_ok THEN RAISE EXCEPTION 'invalid manager PIN'; END IF;
  END IF;

  UPDATE public.pos_return_authorizations
     SET state = p_to_state,
         approver_id             = CASE WHEN p_to_state = 'approved' THEN v_uid ELSE approver_id END,
         approved_at             = CASE WHEN p_to_state = 'approved' THEN now() ELSE approved_at END,
         rejected_at             = CASE WHEN p_to_state = 'rejected' THEN now() ELSE rejected_at END,
         applied_at              = CASE WHEN p_to_state = 'applied'  THEN now() ELSE applied_at  END,
         manager_pin_verified_at = CASE WHEN p_to_state = 'approved' THEN now() ELSE manager_pin_verified_at END,
         updated_at              = now()
   WHERE id = p_id;

  RETURN p_id;
END $$;

REVOKE ALL ON FUNCTION public.pos_return_authorization_transition(uuid, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.pos_return_authorization_transition(uuid, text, text)
  TO authenticated, service_role;
