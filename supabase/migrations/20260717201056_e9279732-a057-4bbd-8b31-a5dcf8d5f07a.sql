
-- ================================================================
-- Phase 4c — Cycle counting
-- ================================================================

-- 1. Enums --------------------------------------------------------
DO $$ BEGIN
  CREATE TYPE public.wms_count_state AS ENUM ('draft','counting','review','posted','cancelled');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE public.wms_count_strategy AS ENUM ('abc','random','targeted');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- 2. Sessions -----------------------------------------------------
CREATE TABLE public.wms_count_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  business_id uuid NOT NULL,
  branch_id uuid NULL,
  warehouse_id uuid NOT NULL,
  code text NOT NULL,
  strategy public.wms_count_strategy NOT NULL DEFAULT 'targeted',
  state public.wms_count_state NOT NULL DEFAULT 'draft',
  notes text NULL,
  posted_at timestamptz NULL,
  posted_by uuid NULL,
  created_by uuid NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (business_id, code)
);

CREATE INDEX idx_wms_count_sessions_wh ON public.wms_count_sessions(warehouse_id, state);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.wms_count_sessions TO authenticated;
GRANT ALL ON public.wms_count_sessions TO service_role;

ALTER TABLE public.wms_count_sessions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "wms_count_sessions business scoped select"
  ON public.wms_count_sessions FOR SELECT TO authenticated
  USING (public.user_can_access_business(auth.uid(), business_id));
CREATE POLICY "wms_count_sessions business scoped write"
  ON public.wms_count_sessions FOR ALL TO authenticated
  USING (public.user_can_access_business(auth.uid(), business_id))
  WITH CHECK (public.user_can_access_business(auth.uid(), business_id));

CREATE TRIGGER trg_wms_count_sessions_updated_at
  BEFORE UPDATE ON public.wms_count_sessions
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- 3. Lines --------------------------------------------------------
CREATE TABLE public.wms_count_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id uuid NOT NULL REFERENCES public.wms_count_sessions(id) ON DELETE CASCADE,
  organization_id uuid NOT NULL,
  business_id uuid NOT NULL,
  location_id uuid NOT NULL,
  product_id uuid NOT NULL,
  lot_number text NULL,
  system_qty numeric NOT NULL DEFAULT 0,
  counted_qty numeric NULL,
  variance_qty numeric NULL,
  note text NULL,
  counted_by uuid NULL,
  counted_at timestamptz NULL,
  posted_adjustment_id uuid NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_wms_count_lines_session ON public.wms_count_lines(session_id);
CREATE INDEX idx_wms_count_lines_business ON public.wms_count_lines(business_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.wms_count_lines TO authenticated;
GRANT ALL ON public.wms_count_lines TO service_role;

ALTER TABLE public.wms_count_lines ENABLE ROW LEVEL SECURITY;

CREATE POLICY "wms_count_lines business scoped select"
  ON public.wms_count_lines FOR SELECT TO authenticated
  USING (public.user_can_access_business(auth.uid(), business_id));
CREATE POLICY "wms_count_lines business scoped write"
  ON public.wms_count_lines FOR ALL TO authenticated
  USING (public.user_can_access_business(auth.uid(), business_id))
  WITH CHECK (public.user_can_access_business(auth.uid(), business_id));

CREATE TRIGGER trg_wms_count_lines_updated_at
  BEFORE UPDATE ON public.wms_count_lines
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- 4. create_count_session ----------------------------------------
CREATE OR REPLACE FUNCTION public.create_count_session(
  p_warehouse_id uuid,
  p_strategy text DEFAULT 'targeted',
  p_location_ids uuid[] DEFAULT NULL,
  p_notes text DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_wh record;
  v_session_id uuid;
  v_code text;
BEGIN
  SELECT id, organization_id, business_id, branch_id
    INTO v_wh
    FROM public.warehouses WHERE id = p_warehouse_id;
  IF v_wh.id IS NULL THEN RAISE EXCEPTION 'warehouse % not found', p_warehouse_id; END IF;
  IF NOT user_can_access_business(auth.uid(), v_wh.business_id) THEN RAISE EXCEPTION 'access denied'; END IF;

  v_code := 'CC-' || to_char(now(), 'YYMMDD-HH24MISS');

  INSERT INTO public.wms_count_sessions (
    organization_id, business_id, branch_id, warehouse_id,
    code, strategy, state, notes, created_by
  ) VALUES (
    v_wh.organization_id, v_wh.business_id, v_wh.branch_id, p_warehouse_id,
    v_code, p_strategy::public.wms_count_strategy, 'counting', p_notes, auth.uid()
  )
  RETURNING id INTO v_session_id;

  -- Snapshot system_qty from stock_quants for the chosen locations
  -- (or every location in the warehouse when p_location_ids is NULL).
  INSERT INTO public.wms_count_lines (
    session_id, organization_id, business_id,
    location_id, product_id, lot_number, system_qty
  )
  SELECT
    v_session_id, v_wh.organization_id, v_wh.business_id,
    q.location_id, q.product_id, q.lot_number, COALESCE(q.quantity, 0)
    FROM public.stock_quants q
    JOIN public.stock_locations sl ON sl.id = q.location_id
   WHERE sl.warehouse_id = p_warehouse_id
     AND q.business_id = v_wh.business_id
     AND (p_location_ids IS NULL OR q.location_id = ANY(p_location_ids));

  BEGIN
    INSERT INTO public.business_event_outbox (
      org_id, branch_id, warehouse_id, event_type,
      source_doc_type, source_doc_id, payload, idempotency_key, status, actor_user_id
    ) VALUES (
      v_wh.organization_id, v_wh.branch_id, p_warehouse_id,
      'warehouse.count.opened',
      'wms_count_session', v_session_id,
      jsonb_build_object(
        'session_id', v_session_id,
        'business_id', v_wh.business_id,
        'warehouse_id', p_warehouse_id,
        'strategy', p_strategy,
        'code', v_code
      ),
      'wms.count.opened:' || v_session_id::text,
      'pending', auth.uid()
    );
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'wms count opened outbox emit failed: %', SQLERRM;
  END;

  RETURN v_session_id;
END; $$;

-- 5. record_count -------------------------------------------------
CREATE OR REPLACE FUNCTION public.record_count(
  p_line_id uuid,
  p_counted_qty numeric,
  p_note text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_line record;
  v_session record;
BEGIN
  SELECT * INTO v_line FROM public.wms_count_lines WHERE id = p_line_id;
  IF v_line.id IS NULL THEN RAISE EXCEPTION 'count line % not found', p_line_id; END IF;
  IF NOT user_can_access_business(auth.uid(), v_line.business_id) THEN RAISE EXCEPTION 'access denied'; END IF;
  IF p_counted_qty < 0 THEN RAISE EXCEPTION 'counted qty must be >= 0'; END IF;

  SELECT * INTO v_session FROM public.wms_count_sessions WHERE id = v_line.session_id;
  IF v_session.state NOT IN ('draft','counting','review') THEN
    RAISE EXCEPTION 'session in state % cannot be counted', v_session.state;
  END IF;

  UPDATE public.wms_count_lines
     SET counted_qty = p_counted_qty,
         variance_qty = p_counted_qty - system_qty,
         note = COALESCE(p_note, note),
         counted_by = auth.uid(),
         counted_at = now()
   WHERE id = p_line_id;

  BEGIN
    INSERT INTO public.business_event_outbox (
      org_id, branch_id, warehouse_id, event_type,
      source_doc_type, source_doc_id, payload, idempotency_key, status, actor_user_id
    ) VALUES (
      v_session.organization_id, v_session.branch_id, v_session.warehouse_id,
      'warehouse.count.recorded',
      'wms_count_line', p_line_id,
      jsonb_build_object(
        'line_id', p_line_id,
        'session_id', v_line.session_id,
        'business_id', v_line.business_id,
        'counted_qty', p_counted_qty,
        'variance_qty', p_counted_qty - v_line.system_qty
      ),
      'wms.count.recorded:' || p_line_id::text || ':' || extract(epoch from now())::text,
      'pending', auth.uid()
    );
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'wms count recorded outbox emit failed: %', SQLERRM;
  END;

  RETURN jsonb_build_object(
    'line_id', p_line_id,
    'variance_qty', p_counted_qty - v_line.system_qty
  );
END; $$;

-- 6. post_count_session ------------------------------------------
CREATE OR REPLACE FUNCTION public.post_count_session(
  p_session_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_session record;
  v_line record;
  v_items jsonb := '[]'::jsonb;
  v_input jsonb;
  v_result jsonb;
  v_adjustment_number text;
  v_variance_count int := 0;
BEGIN
  SELECT * INTO v_session FROM public.wms_count_sessions WHERE id = p_session_id;
  IF v_session.id IS NULL THEN RAISE EXCEPTION 'session % not found', p_session_id; END IF;
  IF NOT user_can_access_business(auth.uid(), v_session.business_id) THEN RAISE EXCEPTION 'access denied'; END IF;
  IF v_session.state IN ('posted','cancelled') THEN
    RAISE EXCEPTION 'session in state % cannot be posted', v_session.state;
  END IF;

  -- Build one adjustment item per non-zero-variance counted line.
  FOR v_line IN
    SELECT * FROM public.wms_count_lines
     WHERE session_id = p_session_id
       AND counted_qty IS NOT NULL
       AND COALESCE(variance_qty, 0) <> 0
  LOOP
    v_items := v_items || jsonb_build_object(
      'product_id',          v_line.product_id,
      'quantity_before',     v_line.system_qty,
      'quantity_adjustment', v_line.variance_qty,
      'quantity_after',      v_line.counted_qty,
      'lot_number',          v_line.lot_number,
      'notes',               COALESCE(v_line.note, 'cycle count ' || v_session.code)
    );
    v_variance_count := v_variance_count + 1;
  END LOOP;

  IF v_variance_count > 0 THEN
    v_adjustment_number := v_session.code || '-ADJ';

    v_input := jsonb_build_object(
      'organization_id', v_session.organization_id,
      'business_id',     v_session.business_id,
      'branch_id',       v_session.branch_id,
      'warehouse_id',    v_session.warehouse_id,
      'adjustment_number', v_adjustment_number,
      'reason',          'cycle_count',
      'notes',           'Cycle count session ' || v_session.code,
      'client_request_id', gen_random_uuid(),
      'items',           v_items
    );

    v_result := public.apply_or_request_stock_adjustment(v_input, auth.uid());
    IF NOT COALESCE((v_result->>'success')::boolean, false) THEN
      RAISE EXCEPTION 'cycle count adjustment failed: %', v_result->>'error';
    END IF;

    UPDATE public.wms_count_lines
       SET posted_adjustment_id = (v_result->>'adjustment_id')::uuid
     WHERE session_id = p_session_id
       AND counted_qty IS NOT NULL
       AND COALESCE(variance_qty, 0) <> 0;
  END IF;

  UPDATE public.wms_count_sessions
     SET state = 'posted', posted_at = now(), posted_by = auth.uid()
   WHERE id = p_session_id;

  BEGIN
    INSERT INTO public.business_event_outbox (
      org_id, branch_id, warehouse_id, event_type,
      source_doc_type, source_doc_id, payload, idempotency_key, status, actor_user_id
    ) VALUES (
      v_session.organization_id, v_session.branch_id, v_session.warehouse_id,
      'warehouse.count.posted',
      'wms_count_session', p_session_id,
      jsonb_build_object(
        'session_id', p_session_id,
        'business_id', v_session.business_id,
        'variance_count', v_variance_count,
        'adjustment_id', COALESCE((v_result->>'adjustment_id')::uuid, NULL)
      ),
      'wms.count.posted:' || p_session_id::text,
      'pending', auth.uid()
    );
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'wms count posted outbox emit failed: %', SQLERRM;
  END;

  RETURN jsonb_build_object(
    'session_id', p_session_id,
    'variance_count', v_variance_count,
    'adjustment_result', v_result
  );
END; $$;
