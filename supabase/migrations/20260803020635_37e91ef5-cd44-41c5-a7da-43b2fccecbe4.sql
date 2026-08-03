-- =====================================================================
-- Phase 2 — Cycle count control plane.
-- =====================================================================

DO $$ BEGIN
  CREATE TYPE public.wms_count_variance_reason AS ENUM (
    'damage','mis_pick','wrong_location','shrinkage','receiving_error',
    'production_error','duplicate_count','unknown_loss','system_error'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE public.wms_count_sessions
  ADD COLUMN IF NOT EXISTS is_blind boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS recount_round integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS requires_approval boolean NOT NULL DEFAULT true;

ALTER TABLE public.wms_count_lines
  ADD COLUMN IF NOT EXISTS variance_reason public.wms_count_variance_reason NULL,
  ADD COLUMN IF NOT EXISTS recount_of_line_id uuid NULL
    REFERENCES public.wms_count_lines(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS assigned_to uuid NULL,
  ADD COLUMN IF NOT EXISTS serial_numbers text[] NULL,
  ADD COLUMN IF NOT EXISTS expiry_date date NULL,
  ADD COLUMN IF NOT EXISTS tolerance_outcome text NULL
    CHECK (tolerance_outcome IN ('within_tolerance','recount_required','approval_required')
           OR tolerance_outcome IS NULL),
  ADD COLUMN IF NOT EXISTS recount_round integer NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_wms_count_lines_assigned
  ON public.wms_count_lines(assigned_to) WHERE assigned_to IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_wms_count_lines_outcome
  ON public.wms_count_lines(session_id, tolerance_outcome);

-- 1. Canonical tolerance evaluation -----------------------------------
-- Single owner of "is this variance acceptable?". Reads the Inventory
-- tolerance policy table — Warehouse never defines its own thresholds.
CREATE OR REPLACE FUNCTION public.evaluate_count_tolerance(
  p_business_id uuid,
  p_warehouse_id uuid,
  p_product_id uuid,
  p_system_qty numeric,
  p_counted_qty numeric
) RETURNS text
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE
  v_pol record;
  v_cat uuid;
  v_var numeric;
  v_pct numeric;
  v_cost numeric;
  v_value numeric;
BEGIN
  v_var := ABS(COALESCE(p_counted_qty, 0) - COALESCE(p_system_qty, 0));
  IF v_var = 0 THEN RETURN 'within_tolerance'; END IF;

  SELECT category_id, COALESCE(cost_price, 0) INTO v_cat, v_cost
    FROM public.products WHERE id = p_product_id;

  -- Most specific policy wins: warehouse+category → warehouse → category → business.
  SELECT * INTO v_pol
    FROM public.physical_count_tolerance_policies
   WHERE business_id = p_business_id
     AND is_active = true
     AND (warehouse_id IS NULL OR warehouse_id = p_warehouse_id)
     AND (category_id  IS NULL OR category_id  = v_cat)
   ORDER BY (warehouse_id IS NOT NULL)::int + (category_id IS NOT NULL)::int DESC
   LIMIT 1;

  IF NOT FOUND THEN
    -- No policy configured: any variance needs a human.
    RETURN 'approval_required';
  END IF;

  v_pct   := CASE WHEN COALESCE(p_system_qty, 0) = 0 THEN 100
                  ELSE (v_var / ABS(p_system_qty)) * 100 END;
  v_value := v_var * v_cost;

  IF (v_pol.variance_pct IS NOT NULL AND v_pct > v_pol.variance_pct)
     OR (v_pol.variance_value IS NOT NULL AND v_value > v_pol.variance_value) THEN
    IF v_pol.require_recount THEN RETURN 'recount_required'; END IF;
    RETURN 'approval_required';
  END IF;

  IF v_pol.require_manager_approval THEN RETURN 'approval_required'; END IF;
  RETURN 'within_tolerance';
END $$;

GRANT EXECUTE ON FUNCTION public.evaluate_count_tolerance(uuid, uuid, uuid, numeric, numeric)
  TO authenticated, service_role;

-- 2. record_count — server-side tolerance + reason capture -------------
CREATE OR REPLACE FUNCTION public.record_count(
  p_line_id uuid,
  p_counted_qty numeric,
  p_note text DEFAULT NULL,
  p_variance_reason text DEFAULT NULL,
  p_serial_numbers text[] DEFAULT NULL,
  p_expiry_date date DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_line record;
  v_session record;
  v_outcome text;
  v_variance numeric;
BEGIN
  SELECT * INTO v_line FROM public.wms_count_lines WHERE id = p_line_id;
  IF v_line.id IS NULL THEN RAISE EXCEPTION 'count line % not found', p_line_id; END IF;
  IF NOT user_can_access_business(auth.uid(), v_line.business_id) THEN RAISE EXCEPTION 'access denied'; END IF;
  IF p_counted_qty < 0 THEN RAISE EXCEPTION 'counted qty must be >= 0'; END IF;

  SELECT * INTO v_session FROM public.wms_count_sessions WHERE id = v_line.session_id;
  IF v_session.state NOT IN ('draft','counting','review') THEN
    RAISE EXCEPTION 'session in state % cannot be counted', v_session.state;
  END IF;

  v_variance := p_counted_qty - v_line.system_qty;

  v_outcome := public.evaluate_count_tolerance(
    v_line.business_id, v_session.warehouse_id, v_line.product_id,
    v_line.system_qty, p_counted_qty
  );

  UPDATE public.wms_count_lines
     SET counted_qty = p_counted_qty,
         variance_qty = v_variance,
         note = COALESCE(p_note, note),
         variance_reason = CASE
           WHEN p_variance_reason IS NULL THEN variance_reason
           ELSE p_variance_reason::public.wms_count_variance_reason END,
         serial_numbers = COALESCE(p_serial_numbers, serial_numbers),
         expiry_date = COALESCE(p_expiry_date, expiry_date),
         tolerance_outcome = v_outcome,
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
        'variance_qty', v_variance,
        'tolerance_outcome', v_outcome
      ),
      'wms.count.recorded:' || p_line_id::text || ':' || extract(epoch from now())::text,
      'pending', auth.uid()
    );
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'wms count recorded outbox emit failed: %', SQLERRM;
  END;

  -- Blind sessions never hand the expected quantity back to the operator.
  RETURN jsonb_build_object(
    'line_id', p_line_id,
    'tolerance_outcome', v_outcome,
    'variance_qty', CASE WHEN v_session.is_blind THEN NULL ELSE v_variance END,
    'blind', v_session.is_blind
  );
END; $$;

GRANT EXECUTE ON FUNCTION public.record_count(uuid, numeric, text, text, text[], date)
  TO authenticated, service_role;

-- 3. Operator-facing line projection (blind-safe) ----------------------
CREATE OR REPLACE FUNCTION public.get_count_lines(p_session_id uuid)
RETURNS TABLE (
  id uuid,
  location_id uuid,
  location_code text,
  location_name text,
  product_id uuid,
  product_sku text,
  product_name text,
  lot_number text,
  system_qty numeric,
  counted_qty numeric,
  variance_qty numeric,
  variance_reason text,
  tolerance_outcome text,
  assigned_to uuid,
  serial_numbers text[],
  expiry_date date,
  recount_of_line_id uuid,
  recount_round integer,
  counted_at timestamptz,
  is_blind boolean
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE v_session record; v_hide boolean;
BEGIN
  SELECT * INTO v_session FROM public.wms_count_sessions WHERE wms_count_sessions.id = p_session_id;
  IF v_session.id IS NULL THEN RAISE EXCEPTION 'session % not found', p_session_id; END IF;
  IF NOT user_can_access_business(auth.uid(), v_session.business_id) THEN RAISE EXCEPTION 'access denied'; END IF;

  -- Expected figures reappear once the session reaches review.
  v_hide := v_session.is_blind AND v_session.state IN ('draft','counting');

  RETURN QUERY
  SELECT l.id,
         l.location_id, sl.code, sl.name,
         l.product_id, p.sku, p.name,
         l.lot_number,
         CASE WHEN v_hide THEN NULL ELSE l.system_qty END,
         l.counted_qty,
         CASE WHEN v_hide THEN NULL ELSE l.variance_qty END,
         l.variance_reason::text,
         l.tolerance_outcome,
         l.assigned_to,
         l.serial_numbers,
         l.expiry_date,
         l.recount_of_line_id,
         l.recount_round,
         l.counted_at,
         v_session.is_blind
    FROM public.wms_count_lines l
    LEFT JOIN public.stock_locations sl ON sl.id = l.location_id
    LEFT JOIN public.products p ON p.id = l.product_id
   WHERE l.session_id = p_session_id
   ORDER BY sl.code NULLS LAST, p.name;
END $$;

GRANT EXECUTE ON FUNCTION public.get_count_lines(uuid) TO authenticated, service_role;

-- 4. Recount ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.request_count_recount(
  p_line_id uuid,
  p_reason text DEFAULT NULL
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE v_line record; v_session record; v_new_id uuid;
BEGIN
  SELECT * INTO v_line FROM public.wms_count_lines WHERE id = p_line_id;
  IF v_line.id IS NULL THEN RAISE EXCEPTION 'count line % not found', p_line_id; END IF;
  IF NOT user_can_access_business(auth.uid(), v_line.business_id) THEN RAISE EXCEPTION 'access denied'; END IF;

  SELECT * INTO v_session FROM public.wms_count_sessions WHERE id = v_line.session_id;
  IF v_session.state IN ('posted','cancelled') THEN
    RAISE EXCEPTION 'session in state % cannot be recounted', v_session.state;
  END IF;

  INSERT INTO public.wms_count_lines (
    session_id, organization_id, business_id, location_id, product_id,
    lot_number, system_qty, note, recount_of_line_id, recount_round,
    tolerance_outcome
  ) VALUES (
    v_line.session_id, v_line.organization_id, v_line.business_id,
    v_line.location_id, v_line.product_id, v_line.lot_number, v_line.system_qty,
    p_reason, p_line_id, v_line.recount_round + 1, NULL
  ) RETURNING id INTO v_new_id;

  -- The superseded attempt stops contributing to the roll-up.
  UPDATE public.wms_count_lines
     SET tolerance_outcome = 'recount_required'
   WHERE id = p_line_id;

  UPDATE public.wms_count_sessions
     SET recount_round = GREATEST(recount_round, v_line.recount_round + 1),
         state = 'counting'
   WHERE id = v_line.session_id;

  RETURN v_new_id;
END $$;

GRANT EXECUTE ON FUNCTION public.request_count_recount(uuid, text) TO authenticated, service_role;

-- 5. Submit gate — every variance must be explained --------------------
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
  v_row record;
  v_variance_count int := 0;
  v_unexplained int := 0;
  v_open_recounts int := 0;
  v_submit jsonb;
BEGIN
  SELECT * INTO v_session FROM public.wms_count_sessions WHERE id = p_session_id FOR UPDATE;
  IF v_session.id IS NULL THEN RAISE EXCEPTION 'session % not found', p_session_id; END IF;
  IF NOT user_can_access_business(auth.uid(), v_session.business_id) THEN RAISE EXCEPTION 'access denied'; END IF;
  IF v_session.state IN ('posted','cancelled') THEN
    RAISE EXCEPTION 'session in state % cannot be submitted', v_session.state;
  END IF;
  IF v_session.physical_count_id IS NULL THEN
    RAISE EXCEPTION 'session % has no linked inventory count document — reopen the session',
      p_session_id USING ERRCODE='P0001';
  END IF;

  -- Superseded attempts are excluded: only the newest attempt per line chain counts.
  SELECT count(*) INTO v_unexplained
    FROM public.wms_count_lines l
   WHERE l.session_id = p_session_id
     AND l.counted_qty IS NOT NULL
     AND COALESCE(l.variance_qty, 0) <> 0
     AND l.variance_reason IS NULL
     AND NOT EXISTS (SELECT 1 FROM public.wms_count_lines r WHERE r.recount_of_line_id = l.id);

  IF v_unexplained > 0 THEN
    RAISE EXCEPTION 'cannot submit: % variance line(s) have no reason code', v_unexplained
      USING ERRCODE='P0001', HINT='classify every variance before submitting the session';
  END IF;

  SELECT count(*) INTO v_open_recounts
    FROM public.wms_count_lines l
   WHERE l.session_id = p_session_id
     AND l.tolerance_outcome = 'recount_required'
     AND NOT EXISTS (SELECT 1 FROM public.wms_count_lines r WHERE r.recount_of_line_id = l.id);

  IF v_open_recounts > 0 THEN
    RAISE EXCEPTION 'cannot submit: % line(s) still require a recount', v_open_recounts
      USING ERRCODE='P0001';
  END IF;

  FOR v_row IN
    SELECT l.product_id,
           SUM(COALESCE(l.counted_qty, l.system_qty)) AS counted,
           SUM(l.system_qty)                          AS system_qty
      FROM public.wms_count_lines l
     WHERE l.session_id = p_session_id
       AND NOT EXISTS (SELECT 1 FROM public.wms_count_lines r WHERE r.recount_of_line_id = l.id)
     GROUP BY l.product_id
  LOOP
    PERFORM public.physical_count_record_line(
      v_session.physical_count_id, v_row.product_id, v_row.counted, auth.uid(),
      NULL, 'wms_count_session:' || p_session_id::text
    );
    IF v_row.counted <> v_row.system_qty THEN
      v_variance_count := v_variance_count + 1;
    END IF;
  END LOOP;

  v_submit := public.physical_count_submit(v_session.physical_count_id, auth.uid());

  UPDATE public.wms_count_sessions
     SET state = 'review'
   WHERE id = p_session_id
     AND state <> 'review';

  BEGIN
    INSERT INTO public.business_event_outbox (
      org_id, branch_id, warehouse_id, event_type,
      source_doc_type, source_doc_id, payload, idempotency_key, status, actor_user_id
    ) VALUES (
      v_session.organization_id, v_session.branch_id, v_session.warehouse_id,
      'warehouse.count.submitted',
      'wms_count_session', p_session_id,
      jsonb_build_object(
        'session_id', p_session_id,
        'business_id', v_session.business_id,
        'physical_count_id', v_session.physical_count_id,
        'variance_count', v_variance_count
      ),
      'wms.count.submitted:' || p_session_id::text,
      'pending', auth.uid()
    );
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'wms count submitted outbox emit failed: %', SQLERRM;
  END;

  RETURN jsonb_build_object(
    'session_id', p_session_id,
    'physical_count_id', v_session.physical_count_id,
    'variance_count', v_variance_count,
    'submit_result', v_submit,
    'handoff', 'inventory_physical_count'
  );
END; $$;