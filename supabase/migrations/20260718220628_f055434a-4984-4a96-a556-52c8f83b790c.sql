
-- ============================================================================
-- Wave 2 · Phase F — Card Settlement & Reconciliation
-- ============================================================================
-- Groups every card capture into an acquirer batch, tracks reversals, and
-- exposes a manager-gated close RPC that emits `settlement.card.closed` for
-- downstream GL posting. All writes are RPC-mediated so RLS surface stays
-- read-only for clients.

-- ---------------------------------------------------------------------------
-- F.1  pos_card_settlements  (one row per acquirer batch)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.pos_card_settlements (
  id                UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  organization_id   UUID NOT NULL,
  business_id       UUID NOT NULL,
  branch_id         UUID,
  provider_key      TEXT NOT NULL,                          -- 'mpgs', 'stripe_terminal', 'sim', ...
  batch_date        DATE NOT NULL DEFAULT (now() AT TIME ZONE 'UTC')::date,
  opened_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  closed_at         TIMESTAMPTZ,
  closed_by         UUID,
  status            TEXT NOT NULL DEFAULT 'open'
                     CHECK (status IN ('open','closed','reconciled')),
  expected_amount   NUMERIC(18,4) NOT NULL DEFAULT 0,       -- rolled up from lines
  actual_amount     NUMERIC(18,4),                          -- from acquirer statement at close
  variance          NUMERIC(18,4),                          -- actual - expected
  fee_total         NUMERIC(18,4) NOT NULL DEFAULT 0,
  notes             TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Only one OPEN batch per (business, branch, provider) at a time.
CREATE UNIQUE INDEX IF NOT EXISTS pos_card_settlements_open_uniq
  ON public.pos_card_settlements (business_id, COALESCE(branch_id, '00000000-0000-0000-0000-000000000000'::uuid), provider_key)
  WHERE status = 'open';

CREATE INDEX IF NOT EXISTS pos_card_settlements_business_idx
  ON public.pos_card_settlements (business_id, batch_date DESC);
CREATE INDEX IF NOT EXISTS pos_card_settlements_org_idx
  ON public.pos_card_settlements (organization_id, batch_date DESC);

GRANT SELECT ON public.pos_card_settlements TO authenticated;
GRANT ALL    ON public.pos_card_settlements TO service_role;

ALTER TABLE public.pos_card_settlements ENABLE ROW LEVEL SECURITY;

CREATE POLICY "pos_card_settlements_read_business_members"
  ON public.pos_card_settlements FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.user_business_access uba
      WHERE uba.user_id = auth.uid()
        AND uba.business_id = pos_card_settlements.business_id
    )
  );

-- ---------------------------------------------------------------------------
-- F.2  pos_card_settlement_lines  (per-payment batch entries)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.pos_card_settlement_lines (
  id                 UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  settlement_id      UUID NOT NULL REFERENCES public.pos_card_settlements(id) ON DELETE CASCADE,
  organization_id    UUID NOT NULL,
  business_id        UUID NOT NULL,
  branch_id          UUID,
  payment_id         UUID NOT NULL,                     -- pos_transaction_payments.id
  kind               TEXT NOT NULL CHECK (kind IN ('capture','reversal')),
  amount             NUMERIC(18,4) NOT NULL,            -- signed: capture > 0, reversal < 0
  fee                NUMERIC(18,4) NOT NULL DEFAULT 0,
  net                NUMERIC(18,4) NOT NULL,            -- amount - fee
  source_event_id    UUID,                              -- business_event_outbox.id
  source_event_type  TEXT,                              -- 'payment.card.captured' etc.
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Idempotency: one capture line + at most one reversal line per payment.
CREATE UNIQUE INDEX IF NOT EXISTS pos_card_settlement_lines_payment_kind_uniq
  ON public.pos_card_settlement_lines (payment_id, kind);
-- Idempotent event replay.
CREATE UNIQUE INDEX IF NOT EXISTS pos_card_settlement_lines_event_uniq
  ON public.pos_card_settlement_lines (source_event_id)
  WHERE source_event_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS pos_card_settlement_lines_settlement_idx
  ON public.pos_card_settlement_lines (settlement_id);

GRANT SELECT ON public.pos_card_settlement_lines TO authenticated;
GRANT ALL    ON public.pos_card_settlement_lines TO service_role;

ALTER TABLE public.pos_card_settlement_lines ENABLE ROW LEVEL SECURITY;

CREATE POLICY "pos_card_settlement_lines_read_business_members"
  ON public.pos_card_settlement_lines FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.user_business_access uba
      WHERE uba.user_id = auth.uid()
        AND uba.business_id = pos_card_settlement_lines.business_id
    )
  );

-- ---------------------------------------------------------------------------
-- F.3  pos_card_settlement_apply  — dispatcher entry point
-- ---------------------------------------------------------------------------
-- Called by the outbox dispatcher on payment.card.captured / payment.card.reversed.
-- Idempotent: safe to retry the same event or the same (payment_id, kind).
CREATE OR REPLACE FUNCTION public.pos_card_settlement_apply(
  p_event_id       UUID,
  p_payment_id     UUID,
  p_kind           TEXT,
  p_amount         NUMERIC,
  p_org_id         UUID,
  p_business_id    UUID,
  p_branch_id      UUID,
  p_provider_key   TEXT
) RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_settlement_id UUID;
  v_signed        NUMERIC;
BEGIN
  IF p_kind NOT IN ('capture','reversal') THEN
    RAISE EXCEPTION 'pos_card_settlement_apply: invalid kind %', p_kind;
  END IF;

  -- Idempotency shortcut — if this event already produced a line, return.
  IF p_event_id IS NOT NULL THEN
    SELECT settlement_id INTO v_settlement_id
    FROM public.pos_card_settlement_lines
    WHERE source_event_id = p_event_id;
    IF v_settlement_id IS NOT NULL THEN
      RETURN v_settlement_id;
    END IF;
  END IF;

  -- Find or open the current batch for this (business, branch, provider).
  SELECT id INTO v_settlement_id
  FROM public.pos_card_settlements
  WHERE business_id = p_business_id
    AND provider_key = p_provider_key
    AND status = 'open'
    AND COALESCE(branch_id, '00000000-0000-0000-0000-000000000000'::uuid)
        = COALESCE(p_branch_id, '00000000-0000-0000-0000-000000000000'::uuid)
  ORDER BY opened_at DESC
  LIMIT 1
  FOR UPDATE;

  IF v_settlement_id IS NULL THEN
    INSERT INTO public.pos_card_settlements(
      organization_id, business_id, branch_id, provider_key
    ) VALUES (
      p_org_id, p_business_id, p_branch_id, p_provider_key
    )
    RETURNING id INTO v_settlement_id;
  END IF;

  v_signed := CASE p_kind
                WHEN 'capture'  THEN  ABS(p_amount)
                WHEN 'reversal' THEN -ABS(p_amount)
              END;

  -- Insert line (idempotent on (payment_id, kind) and on source_event_id).
  INSERT INTO public.pos_card_settlement_lines(
    settlement_id, organization_id, business_id, branch_id,
    payment_id, kind, amount, fee, net,
    source_event_id, source_event_type
  ) VALUES (
    v_settlement_id, p_org_id, p_business_id, p_branch_id,
    p_payment_id, p_kind, v_signed, 0, v_signed,
    p_event_id,
    CASE p_kind WHEN 'capture' THEN 'payment.card.captured'
                WHEN 'reversal' THEN 'payment.card.reversed' END
  )
  ON CONFLICT (payment_id, kind) DO NOTHING;

  -- Roll up expected_amount so the manager UI shows live batch total.
  UPDATE public.pos_card_settlements s
     SET expected_amount = (
           SELECT COALESCE(SUM(net),0)
           FROM public.pos_card_settlement_lines
           WHERE settlement_id = s.id
         ),
         updated_at = now()
   WHERE s.id = v_settlement_id;

  RETURN v_settlement_id;
END;
$$;

REVOKE ALL ON FUNCTION public.pos_card_settlement_apply(uuid,uuid,text,numeric,uuid,uuid,uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.pos_card_settlement_apply(uuid,uuid,text,numeric,uuid,uuid,uuid,text) TO service_role;

-- ---------------------------------------------------------------------------
-- F.4  pos_close_card_settlement  — manager close + variance + outbox emit
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.pos_close_card_settlement(
  p_settlement_id  UUID,
  p_actual_amount  NUMERIC,
  p_notes          TEXT DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row      public.pos_card_settlements%ROWTYPE;
  v_expected NUMERIC;
  v_variance NUMERIC;
BEGIN
  SELECT * INTO v_row FROM public.pos_card_settlements WHERE id = p_settlement_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'settlement % not found', p_settlement_id;
  END IF;
  IF v_row.status <> 'open' THEN
    RAISE EXCEPTION 'settlement % is % — only open batches can be closed', p_settlement_id, v_row.status;
  END IF;

  -- Manager role required. Reuses the existing has_role helper; other
  -- privilege paths (admin/owner) can be added later if the RBAC model
  -- grows.
  IF NOT (
       public.has_role(auth.uid(), 'admin'::app_role)
    OR public.has_role(auth.uid(), 'manager'::app_role)
  ) THEN
    RAISE EXCEPTION 'INSUFFICIENT_PRIVILEGE: only admins/managers can close card settlements';
  END IF;

  SELECT COALESCE(SUM(net),0) INTO v_expected
  FROM public.pos_card_settlement_lines
  WHERE settlement_id = p_settlement_id;

  v_variance := p_actual_amount - v_expected;

  UPDATE public.pos_card_settlements
     SET status          = 'closed',
         closed_at       = now(),
         closed_by       = auth.uid(),
         expected_amount = v_expected,
         actual_amount   = p_actual_amount,
         variance        = v_variance,
         notes           = COALESCE(p_notes, notes),
         updated_at      = now()
   WHERE id = p_settlement_id;

  INSERT INTO public.business_event_outbox(
    org_id, branch_id, event_type,
    source_doc_type, source_doc_id, payload,
    idempotency_key, source
  ) VALUES (
    v_row.organization_id, v_row.branch_id, 'settlement.card.closed',
    'pos_card_settlement', p_settlement_id,
    jsonb_build_object(
      'settlement_id',    p_settlement_id,
      'business_id',      v_row.business_id,
      'branch_id',        v_row.branch_id,
      'provider_key',     v_row.provider_key,
      'expected_amount',  v_expected,
      'actual_amount',    p_actual_amount,
      'variance',         v_variance,
      'batch_date',       v_row.batch_date,
      'closed_by',        auth.uid()
    ),
    'pos_card_settlement_close:' || p_settlement_id::text,
    'rpc:pos_close_card_settlement'
  )
  ON CONFLICT DO NOTHING;

  RETURN jsonb_build_object(
    'settlement_id',   p_settlement_id,
    'expected_amount', v_expected,
    'actual_amount',   p_actual_amount,
    'variance',        v_variance,
    'status',          'closed'
  );
END;
$$;

REVOKE ALL ON FUNCTION public.pos_close_card_settlement(uuid,numeric,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.pos_close_card_settlement(uuid,numeric,text) TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- F.5  Register new topic + updated_at trigger reuse
-- ---------------------------------------------------------------------------
INSERT INTO public.business_event_topics
  (topic_prefix, producer_domain, consumer_domains, handler_scope, max_attempts)
VALUES
  ('settlement.card.closed', 'pos',
   ARRAY['finance','reconciliation']::text[], 'server', 10)
ON CONFLICT (topic_prefix) DO UPDATE
  SET handler_scope = EXCLUDED.handler_scope,
      max_attempts  = EXCLUDED.max_attempts,
      consumer_domains = EXCLUDED.consumer_domains;

-- updated_at trigger — reuses existing helper if present.
DO $do$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'update_updated_at_column' AND pronamespace = 'public'::regnamespace) THEN
    EXECUTE 'DROP TRIGGER IF EXISTS trg_pos_card_settlements_updated_at ON public.pos_card_settlements';
    EXECUTE 'CREATE TRIGGER trg_pos_card_settlements_updated_at BEFORE UPDATE ON public.pos_card_settlements FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column()';
  END IF;
END
$do$;
