-- 1. Incentive rate on labour targets (date-effective master data).
ALTER TABLE public.wms_labour_targets
  ADD COLUMN IF NOT EXISTS incentive_rate_per_earned_hour numeric NOT NULL DEFAULT 0;

-- 2. Payroll-owned staging inbox for pre-run variable inputs.
CREATE TABLE IF NOT EXISTS public.payroll_pending_inputs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  business_id uuid NOT NULL,
  employee_id uuid NOT NULL,
  code text NOT NULL,
  label text,
  quantity numeric NOT NULL DEFAULT 0,
  amount numeric NOT NULL DEFAULT 0,
  uom text NOT NULL DEFAULT 'amount',
  period_start date NOT NULL,
  period_end date NOT NULL,
  source_kind text NOT NULL,
  source_id uuid,
  status text NOT NULL DEFAULT 'pending',
  consumed_payroll_run_id uuid,
  consumed_at timestamptz,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.payroll_pending_inputs TO authenticated;
GRANT ALL ON public.payroll_pending_inputs TO service_role;

ALTER TABLE public.payroll_pending_inputs ENABLE ROW LEVEL SECURITY;

CREATE POLICY payroll_pending_inputs_select ON public.payroll_pending_inputs
  FOR SELECT TO authenticated
  USING (public.user_can_access_business(auth.uid(), business_id));

CREATE POLICY payroll_pending_inputs_write ON public.payroll_pending_inputs
  FOR ALL TO authenticated
  USING (public.user_can_access_business(auth.uid(), business_id)
         AND public.user_has_module_permission(auth.uid(), business_id, 'payroll', 'write'))
  WITH CHECK (public.user_can_access_business(auth.uid(), business_id)
         AND public.user_has_module_permission(auth.uid(), business_id, 'payroll', 'write'));

-- Idempotency: one staged row per employee/code/window/source.
CREATE UNIQUE INDEX IF NOT EXISTS uq_payroll_pending_inputs_source
  ON public.payroll_pending_inputs (business_id, employee_id, code, period_start, period_end, source_kind);

CREATE INDEX IF NOT EXISTS idx_payroll_pending_inputs_open
  ON public.payroll_pending_inputs (business_id, status, period_end);

CREATE TRIGGER trg_payroll_pending_inputs_updated_at
  BEFORE UPDATE ON public.payroll_pending_inputs
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- 3. Warehouse producer: stage incentive pay from the operator scorecard.
CREATE OR REPLACE FUNCTION public.wms_post_incentive_inputs(
  _business_id uuid,
  _code text,
  _from date,
  _to date,
  _warehouse_id uuid DEFAULT NULL
) RETURNS TABLE(employees_staged integer, total_amount numeric)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_org uuid;
  v_count integer := 0;
  v_total numeric := 0;
BEGIN
  IF NOT public.user_can_access_business(auth.uid(), _business_id)
     OR NOT public.user_has_module_permission(auth.uid(), _business_id, 'inventory', 'write') THEN
    RAISE EXCEPTION 'Not permitted to post warehouse incentive pay';
  END IF;

  IF _to < _from THEN
    RAISE EXCEPTION 'Invalid window: % to %', _from, _to;
  END IF;

  SELECT organization_id INTO v_org FROM public.businesses WHERE id = _business_id;
  IF v_org IS NULL THEN
    RAISE EXCEPTION 'Unknown business';
  END IF;

  -- The declared input slot must exist for this business/org.
  IF NOT EXISTS (
    SELECT 1 FROM public.payroll_input_types t
     WHERE t.code = _code AND t.is_active
       AND t.organization_id = v_org
       AND (t.business_id IS NULL OR t.business_id = _business_id)
  ) THEN
    RAISE EXCEPTION 'Payroll input code % is not configured for this business', _code;
  END IF;

  -- Period safety: refuse when the covering payroll period is closed/locked.
  IF EXISTS (
    SELECT 1 FROM public.payroll_periods p
     WHERE p.business_id = _business_id
       AND p.start_date <= _to AND p.end_date >= _from
       AND (p.status::text IN ('closed', 'locked') OR p.closed_at IS NOT NULL)
  ) THEN
    RAISE EXCEPTION 'The payroll period covering % to % is closed', _from, _to;
  END IF;

  WITH sc AS (
    SELECT s.*, o.business_id, o.employee_id
      FROM public.wms_operator_scorecard(_warehouse_id, _from, _to) s
      JOIN public.wms_operators o ON o.id = s.operator_id
     WHERE o.business_id = _business_id
       AND o.employee_id IS NOT NULL
       AND s.incentive_eligible
       AND s.earned_seconds > 0
  ), priced AS (
    SELECT sc.employee_id,
           sc.operator_id,
           sc.earned_seconds,
           sc.performance_pct,
           t.target_performance_pct,
           t.incentive_threshold_pct,
           t.incentive_rate_per_earned_hour AS rate,
           ROUND((sc.earned_seconds / 3600.0) * t.incentive_rate_per_earned_hour, 2) AS amount,
           ROUND(sc.earned_seconds / 3600.0, 2) AS earned_hours
      FROM sc
      LEFT JOIN LATERAL public.wms_resolve_labour_target(
                  sc.business_id, sc.operator_id, NULL, sc.warehouse_id, _to) t ON true
     WHERE COALESCE(t.incentive_rate_per_earned_hour, 0) > 0
  ), upserted AS (
    INSERT INTO public.payroll_pending_inputs (
      organization_id, business_id, employee_id, code, label,
      quantity, amount, uom, period_start, period_end,
      source_kind, source_id, status, metadata, created_by
    )
    SELECT v_org, _business_id, p.employee_id, _code,
           'Warehouse incentive pay',
           p.earned_hours, p.amount, 'amount', _from, _to,
           'wms_labour_incentive', p.operator_id, 'pending',
           jsonb_build_object(
             'window_from', _from,
             'window_to', _to,
             'warehouse_id', _warehouse_id,
             'earned_seconds', p.earned_seconds,
             'performance_pct', p.performance_pct,
             'target_performance_pct', p.target_performance_pct,
             'incentive_threshold_pct', p.incentive_threshold_pct,
             'rate_per_earned_hour', p.rate
           ),
           auth.uid()
      FROM priced p
    ON CONFLICT (business_id, employee_id, code, period_start, period_end, source_kind)
    DO UPDATE SET
      quantity = EXCLUDED.quantity,
      amount = EXCLUDED.amount,
      metadata = EXCLUDED.metadata,
      status = 'pending',
      consumed_payroll_run_id = NULL,
      consumed_at = NULL,
      updated_at = now()
    WHERE public.payroll_pending_inputs.status <> 'consumed'
    RETURNING amount
  )
  SELECT count(*)::int, COALESCE(SUM(amount), 0) INTO v_count, v_total FROM upserted;

  RETURN QUERY SELECT v_count, v_total;
END;
$$;

REVOKE ALL ON FUNCTION public.wms_post_incentive_inputs(uuid, text, date, date, uuid) FROM public;
GRANT EXECUTE ON FUNCTION public.wms_post_incentive_inputs(uuid, text, date, date, uuid) TO authenticated;

-- 4. Payroll consumption / release.
CREATE OR REPLACE FUNCTION public.payroll_consume_pending_inputs(
  _business_id uuid,
  _payroll_run_id uuid,
  _period_start date,
  _period_end date
) RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE v_n integer;
BEGIN
  IF NOT public.user_can_access_business(auth.uid(), _business_id)
     OR NOT public.user_has_module_permission(auth.uid(), _business_id, 'payroll', 'write') THEN
    RAISE EXCEPTION 'Not permitted';
  END IF;

  UPDATE public.payroll_pending_inputs
     SET status = 'consumed',
         consumed_payroll_run_id = _payroll_run_id,
         consumed_at = now(),
         updated_at = now()
   WHERE business_id = _business_id
     AND status = 'pending'
     AND period_start >= _period_start
     AND period_end <= _period_end;

  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END;
$$;

CREATE OR REPLACE FUNCTION public.payroll_release_pending_inputs(
  _business_id uuid,
  _payroll_run_id uuid
) RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE v_n integer;
BEGIN
  IF NOT public.user_can_access_business(auth.uid(), _business_id)
     OR NOT public.user_has_module_permission(auth.uid(), _business_id, 'payroll', 'write') THEN
    RAISE EXCEPTION 'Not permitted';
  END IF;

  UPDATE public.payroll_pending_inputs
     SET status = 'pending',
         consumed_payroll_run_id = NULL,
         consumed_at = NULL,
         updated_at = now()
   WHERE business_id = _business_id
     AND consumed_payroll_run_id = _payroll_run_id;

  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END;
$$;

REVOKE ALL ON FUNCTION public.payroll_consume_pending_inputs(uuid, uuid, date, date) FROM public;
REVOKE ALL ON FUNCTION public.payroll_release_pending_inputs(uuid, uuid) FROM public;
GRANT EXECUTE ON FUNCTION public.payroll_consume_pending_inputs(uuid, uuid, date, date) TO authenticated;
GRANT EXECUTE ON FUNCTION public.payroll_release_pending_inputs(uuid, uuid) TO authenticated;