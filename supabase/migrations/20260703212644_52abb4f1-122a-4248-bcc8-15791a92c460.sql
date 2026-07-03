
-- =====================================================================
-- Phase 6 — Correction & archival
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Multi-country: country_code on pay_schedules
-- ---------------------------------------------------------------------
ALTER TABLE public.pay_schedules
  ADD COLUMN IF NOT EXISTS country_code text;

-- Best-effort backfill from businesses.country_code when available.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name='businesses' AND column_name='country_code'
  ) THEN
    EXECUTE $sql$
      UPDATE public.pay_schedules s
         SET country_code = b.country_code
        FROM public.businesses b
       WHERE s.business_id = b.id
         AND s.country_code IS NULL
         AND b.country_code IS NOT NULL
    $sql$;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_pay_schedules_country_code
  ON public.pay_schedules(country_code)
  WHERE country_code IS NOT NULL;

-- ---------------------------------------------------------------------
-- 2. payroll_period_archive() — platform-admin only
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.payroll_period_archive(
  _period_id uuid,
  _reason text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _p public.payroll_periods;
  _actor uuid := auth.uid();
BEGIN
  IF _reason IS NULL OR length(trim(_reason)) = 0 THEN
    RAISE EXCEPTION 'reason is required to archive a payroll period' USING ERRCODE='22023';
  END IF;

  SELECT * INTO _p FROM public.payroll_periods WHERE id = _period_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'payroll period % not found', _period_id USING ERRCODE='P0002';
  END IF;

  IF _actor IS NULL OR NOT public.is_platform_admin(_actor) THEN
    RAISE EXCEPTION 'only platform admins may archive payroll periods' USING ERRCODE='42501';
  END IF;

  IF _p.status <> 'closed'::public.payroll_period_status THEN
    RAISE EXCEPTION 'only closed periods may be archived (current: %)', _p.status
      USING ERRCODE='22023';
  END IF;

  PERFORM public.payroll_period_transition(
    _period_id,
    'archived'::public.payroll_period_status,
    _reason,
    jsonb_build_object('archived_by', _actor)
  );

  RETURN jsonb_build_object('ok', true, 'code', 'archived');
END $$;

REVOKE ALL ON FUNCTION public.payroll_period_archive(uuid, text) FROM public;
GRANT EXECUTE ON FUNCTION public.payroll_period_archive(uuid, text) TO authenticated, service_role;

-- ---------------------------------------------------------------------
-- 3. payroll_period_open_correction() — reopened → preparing
--    Formalises the correction cycle. Callers can then use the existing
--    payroll_correction_adjustments flow to record the delta; when
--    correction runs are posted and the period is closed again, the
--    audit trail links the two closures via correction_cycle.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.payroll_period_open_correction(
  _period_id uuid,
  _reason text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _p public.payroll_periods;
  _actor uuid := auth.uid();
  _cycle int;
BEGIN
  IF _reason IS NULL OR length(trim(_reason)) = 0 THEN
    RAISE EXCEPTION 'reason is required to open a correction cycle' USING ERRCODE='22023';
  END IF;

  SELECT * INTO _p FROM public.payroll_periods WHERE id = _period_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'payroll period % not found', _period_id USING ERRCODE='P0002';
  END IF;

  IF _actor IS NULL
     OR NOT (public.has_role(_actor, _p.organization_id, 'admin'::public.app_role)
          OR public.has_role(_actor, _p.organization_id, 'hr_admin'::public.app_role)
          OR public.has_role(_actor, _p.organization_id, 'payroll_admin'::public.app_role)) THEN
    RAISE EXCEPTION 'not authorized to open a correction cycle' USING ERRCODE='42501';
  END IF;

  IF _p.status <> 'reopened'::public.payroll_period_status THEN
    RAISE EXCEPTION 'correction cycle requires a reopened period (current: %)', _p.status
      USING ERRCODE='22023';
  END IF;

  -- Count prior correction cycles from the audit trail.
  SELECT COALESCE(MAX((payload->>'correction_cycle')::int), 0) + 1
    INTO _cycle
    FROM public.payroll_period_audit
   WHERE period_id = _period_id
     AND payload ? 'correction_cycle';

  PERFORM public.payroll_period_transition(
    _period_id,
    'preparing'::public.payroll_period_status,
    _reason,
    jsonb_build_object('correction_cycle', _cycle, 'opened_by', _actor)
  );

  RETURN jsonb_build_object('ok', true, 'code', 'correction_opened', 'cycle', _cycle);
END $$;

REVOKE ALL ON FUNCTION public.payroll_period_open_correction(uuid, text) FROM public;
GRANT EXECUTE ON FUNCTION public.payroll_period_open_correction(uuid, text) TO authenticated, service_role;
