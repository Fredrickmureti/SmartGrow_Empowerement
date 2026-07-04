
-- Phase A: unblock Work Entry Type overrides.
--
-- 1) Drop the overly-strict global (org, code) unique index that made pack
--    default + tenant override coexistence impossible. The correct
--    uniqueness rule already exists: uq_work_entry_types_business_code
--    on (org, COALESCE(business_id, sentinel), code).
DROP INDEX IF EXISTS public.payroll_work_entry_types_org_code_uidx;

-- 2) Deterministic resolver: return the tenant override for (org, business, code)
--    if one exists, otherwise the pack-default row (business_id IS NULL),
--    otherwise NULL. This is the single lookup path every downstream
--    consumer (projector, engine, reports) must use.
CREATE OR REPLACE FUNCTION public.payroll_resolve_wet(
  _org_id      uuid,
  _business_id uuid,
  _code        text
)
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT id
    FROM public.payroll_work_entry_types
   WHERE organization_id = _org_id
     AND code = _code
     AND (business_id = _business_id OR business_id IS NULL)
   ORDER BY (business_id IS NULL) ASC  -- tenant row (false) sorts before pack row (true)
   LIMIT 1
$$;

GRANT EXECUTE ON FUNCTION public.payroll_resolve_wet(uuid, uuid, text)
  TO authenticated, service_role;

-- 3) Rewrite the projector's WET id lookups to go through the resolver.
--    Everything else in the function is preserved verbatim from the
--    2026-06-29 migration.
CREATE OR REPLACE FUNCTION public.payroll_work_entries_project(_run_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_user uuid := auth.uid();
  v_run  record;
  v_require_preapproval boolean := false;
  v_locked int := 0;
  v_types jsonb := '{}'::jsonb;
  v_employees int := 0;
  v_sources text[] := ARRAY[]::text[];
  v_id_work uuid; v_id_ot uuid; v_id_lp uuid; v_id_lu uuid; v_id_h uuid; v_id_wh uuid;
BEGIN
  SELECT * INTO v_run FROM public.payroll_runs WHERE id = _run_id;
  IF v_run.id IS NULL THEN RAISE EXCEPTION 'PAYROLL_RUN_NOT_FOUND'; END IF;

  IF v_user IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.user_roles
     WHERE user_id = v_user AND organization_id = v_run.organization_id
       AND role IN ('super_admin','owner','admin','accountant')
  ) THEN
    RAISE EXCEPTION 'PERMISSION_DENIED';
  END IF;

  IF v_run.status NOT IN ('draft','processing') THEN
    RAISE EXCEPTION 'RUN_NOT_EDITABLE';
  END IF;

  PERFORM public.ensure_canonical_work_entry_types(v_run.organization_id);

  -- Resolver-based lookups: tenant override wins over pack default.
  v_id_work := public.payroll_resolve_wet(v_run.organization_id, v_run.business_id, 'WORK');
  v_id_ot   := public.payroll_resolve_wet(v_run.organization_id, v_run.business_id, 'OT');
  v_id_lp   := public.payroll_resolve_wet(v_run.organization_id, v_run.business_id, 'LEAVE_PAID');
  v_id_lu   := public.payroll_resolve_wet(v_run.organization_id, v_run.business_id, 'LEAVE_UNPAID');
  v_id_h    := public.payroll_resolve_wet(v_run.organization_id, v_run.business_id, 'HOLIDAY');
  v_id_wh   := public.payroll_resolve_wet(v_run.organization_id, v_run.business_id, 'WORKED_HOLIDAY');

  v_locked := public.attendance_lock_for_period(
    v_run.organization_id, v_run.pay_period_start, v_run.pay_period_end, _run_id, NULL
  );

  SELECT COALESCE(BOOL_OR(require_ot_preapproval), false)
    INTO v_require_preapproval
    FROM public.attendance_settings
   WHERE organization_id = v_run.organization_id
     AND (v_run.business_id IS NULL OR business_id = v_run.business_id);

  DELETE FROM public.payroll_work_entries WHERE payroll_run_id = _run_id;

  -- 3a) Attendance — WORK (regular hours) and, when a holiday overlaps, WORKED_HOLIDAY.
  --     Overtime hours are stamped on a SEPARATE OT row so the OT multiplier
  --     is reachable via worked_hours['OT'] in salary rule expressions.
  WITH approved_ot AS (
    SELECT employee_id, COALESCE(SUM(requested_hours), 0) AS approved_hours
      FROM public.overtime_requests
     WHERE organization_id = v_run.organization_id
       AND (v_run.business_id IS NULL OR business_id = v_run.business_id)
       AND status = 'approved'
       AND requested_date BETWEEN v_run.pay_period_start AND v_run.pay_period_end
     GROUP BY employee_id
  ),
  hol_dates AS (
    SELECT ph.holiday_date
      FROM public.public_holidays ph
     WHERE ph.organization_id = v_run.organization_id
       AND ph.holiday_date BETWEEN v_run.pay_period_start AND v_run.pay_period_end
  ),
  att AS (
    SELECT a.employee_id,
           a.attendance_date,
           COALESCE(a.total_hours, 0)::numeric AS total_h,
           COALESCE(a.overtime_hours, 0)::numeric AS ot_h,
           EXISTS (SELECT 1 FROM hol_dates hd WHERE hd.holiday_date = a.attendance_date) AS is_holiday
      FROM public.attendance a
     WHERE a.organization_id = v_run.organization_id
       AND (v_run.business_id IS NULL OR a.business_id = v_run.business_id)
       AND a.attendance_date BETWEEN v_run.pay_period_start AND v_run.pay_period_end
       AND a.clock_out IS NOT NULL
       AND COALESCE(a.correction_status,'none') <> 'pending'
       AND a.status NOT IN ('on_leave','holiday','absent')
  ),
  reg_hours AS (
    -- Regular (non-OT) hours split by holiday flag.
    SELECT employee_id,
           is_holiday,
           SUM(GREATEST(total_h - ot_h, 0)) AS hours,
           COUNT(*) AS rows_ct
      FROM att
     GROUP BY employee_id, is_holiday
  ),
  ot_hours AS (
    -- OT hours are capped at approved OT when pre-approval is required.
    SELECT a.employee_id,
           CASE
             WHEN v_require_preapproval
               THEN LEAST(SUM(a.ot_h), COALESCE(MAX(o.approved_hours), 0))
             ELSE SUM(a.ot_h)
           END AS hours,
           COUNT(*) AS rows_ct
      FROM att a
      LEFT JOIN approved_ot o ON o.employee_id = a.employee_id
     GROUP BY a.employee_id
  ),
  reg_ins AS (
    INSERT INTO public.payroll_work_entries (
      organization_id, business_id, payroll_run_id, employee_id,
      work_date_start, work_date_end, hours, overtime_hours, source,
      attendance_count, work_entry_type_id
    )
    SELECT v_run.organization_id, v_run.business_id, _run_id, r.employee_id,
           v_run.pay_period_start, v_run.pay_period_end,
           r.hours, 0, 'attendance', r.rows_ct,
           CASE WHEN r.is_holiday AND v_id_wh IS NOT NULL THEN v_id_wh ELSE v_id_work END
      FROM reg_hours r
     WHERE r.hours > 0
    RETURNING 1
  ),
  ot_ins AS (
    INSERT INTO public.payroll_work_entries (
      organization_id, business_id, payroll_run_id, employee_id,
      work_date_start, work_date_end, hours, overtime_hours, source,
      attendance_count, work_entry_type_id
    )
    SELECT v_run.organization_id, v_run.business_id, _run_id, o.employee_id,
           v_run.pay_period_start, v_run.pay_period_end,
           0, o.hours, 'attendance', o.rows_ct, v_id_ot
      FROM ot_hours o
     WHERE o.hours > 0
    RETURNING 1
  )
  SELECT 1;

  IF EXISTS (SELECT 1 FROM public.payroll_work_entries WHERE payroll_run_id = _run_id AND source='attendance') THEN
    v_sources := v_sources || 'attendance';
  END IF;

  -- 3b) Leave — schedule-aware per employee.
  WITH org_default AS (
    SELECT COALESCE(MAX(standard_hours_per_day), 0)::numeric AS h
      FROM public.work_schedules
     WHERE organization_id = v_run.organization_id
       AND is_default = true
       AND is_active = true
  ),
  emp_sched AS (
    SELECT e.employee_id, ws.id AS schedule_id, ws.standard_hours_per_day
      FROM public.employments e
      LEFT JOIN public.work_schedules ws ON ws.id = e.work_schedule_id
     WHERE e.is_active = true
  ),
  leave_days AS (
    SELECT lr.employee_id,
           COALESCE(lt.is_paid, true) AS is_paid,
           lt.work_entry_type_id AS lt_wet_id,
           gs::date AS leave_date
      FROM public.leave_requests lr
      LEFT JOIN public.leave_types lt ON lt.id = lr.leave_type_id
      CROSS JOIN LATERAL generate_series(
        GREATEST(lr.start_date, v_run.pay_period_start),
        LEAST(lr.end_date, v_run.pay_period_end),
        interval '1 day'
      ) AS gs
     WHERE lr.organization_id = v_run.organization_id
       AND (v_run.business_id IS NULL OR lr.business_id = v_run.business_id)
       AND lr.status = 'approved'
       AND lr.start_date <= v_run.pay_period_end
       AND lr.end_date   >= v_run.pay_period_start
  ),
  scheduled AS (
    SELECT ld.employee_id, ld.is_paid, ld.lt_wet_id, ld.leave_date,
           COALESCE(
             (SELECT wsd.hours FROM public.work_schedule_days wsd
               WHERE wsd.work_schedule_id = es.schedule_id
                 AND wsd.day_of_week = EXTRACT(DOW FROM ld.leave_date)::int
               LIMIT 1),
             es.standard_hours_per_day,
             (SELECT h FROM org_default),
             0
           )::numeric AS hours
      FROM leave_days ld
      LEFT JOIN emp_sched es ON es.employee_id = ld.employee_id
  )
  INSERT INTO public.payroll_work_entries (
    organization_id, business_id, payroll_run_id, employee_id,
    work_date_start, work_date_end, hours, overtime_hours, source,
    attendance_count, work_entry_type_id
  )
  SELECT v_run.organization_id, v_run.business_id, _run_id, s.employee_id,
         v_run.pay_period_start, v_run.pay_period_end,
         COALESCE(SUM(s.hours), 0), 0, 'leave', COUNT(*),
         COALESCE(s.lt_wet_id,
                  CASE WHEN s.is_paid THEN v_id_lp ELSE v_id_lu END)
    FROM scheduled s
   GROUP BY s.employee_id, s.is_paid, s.lt_wet_id
  HAVING COALESCE(SUM(s.hours),0) > 0;

  IF EXISTS (SELECT 1 FROM public.payroll_work_entries WHERE payroll_run_id = _run_id AND source='leave') THEN
    v_sources := v_sources || 'leave';
  END IF;

  -- 3c) Public holidays (non-worked) — only for employees who did NOT work that day.
  WITH org_default AS (
    SELECT COALESCE(MAX(standard_hours_per_day), 0)::numeric AS h
      FROM public.work_schedules
     WHERE organization_id = v_run.organization_id
       AND is_default = true
       AND is_active = true
  ),
  emp_sched AS (
    SELECT e.employee_id, ws.id AS schedule_id, ws.standard_hours_per_day
      FROM public.employments e
      LEFT JOIN public.work_schedules ws ON ws.id = e.work_schedule_id
     WHERE e.is_active = true
  ),
  hol AS (
    SELECT ph.holiday_date
      FROM public.public_holidays ph
     WHERE ph.organization_id = v_run.organization_id
       AND ph.holiday_date BETWEEN v_run.pay_period_start AND v_run.pay_period_end
  ),
  emp AS (
    SELECT DISTINCT employee_id FROM public.payroll_work_entries WHERE payroll_run_id = _run_id
  ),
  worked_hol AS (
    -- Employees who already have a WORKED_HOLIDAY row for a given date should
    -- NOT double-count the holiday allowance.
    SELECT DISTINCT a.employee_id, a.attendance_date
      FROM public.attendance a
      JOIN hol h ON h.holiday_date = a.attendance_date
     WHERE a.organization_id = v_run.organization_id
       AND (v_run.business_id IS NULL OR a.business_id = v_run.business_id)
       AND a.clock_out IS NOT NULL
       AND COALESCE(a.correction_status,'none') <> 'pending'
  ),
  emp_hol AS (
    SELECT e.employee_id, h.holiday_date,
           COALESCE(
             (SELECT wsd.hours FROM public.work_schedule_days wsd
               WHERE wsd.work_schedule_id = es.schedule_id
                 AND wsd.day_of_week = EXTRACT(DOW FROM h.holiday_date)::int
               LIMIT 1),
             es.standard_hours_per_day,
             (SELECT h FROM org_default),
             0
           )::numeric AS hours
      FROM emp e
      CROSS JOIN hol h
      LEFT JOIN emp_sched es ON es.employee_id = e.employee_id
      LEFT JOIN worked_hol wh
        ON wh.employee_id = e.employee_id AND wh.attendance_date = h.holiday_date
     WHERE wh.employee_id IS NULL
  )
  INSERT INTO public.payroll_work_entries (
    organization_id, business_id, payroll_run_id, employee_id,
    work_date_start, work_date_end, hours, overtime_hours, source,
    attendance_count, work_entry_type_id
  )
  SELECT v_run.organization_id, v_run.business_id, _run_id, eh.employee_id,
         v_run.pay_period_start, v_run.pay_period_end,
         COALESCE(SUM(eh.hours), 0), 0, 'holiday', COUNT(*), v_id_h
    FROM emp_hol eh
   GROUP BY eh.employee_id
  HAVING COALESCE(SUM(eh.hours), 0) > 0;

  IF EXISTS (SELECT 1 FROM public.payroll_work_entries WHERE payroll_run_id = _run_id AND source='holiday') THEN
    v_sources := v_sources || 'holiday';
  END IF;

  -- 3d) Back-fill attendance.work_entry_id
  UPDATE public.attendance a
     SET work_entry_id = pwe.id
    FROM public.payroll_work_entries pwe
   WHERE pwe.payroll_run_id = _run_id
     AND pwe.source = 'attendance'
     AND pwe.work_entry_type_id IN (v_id_work, v_id_wh)
     AND a.employee_id = pwe.employee_id
     AND a.organization_id = v_run.organization_id
     AND a.attendance_date BETWEEN v_run.pay_period_start AND v_run.pay_period_end
     AND a.clock_out IS NOT NULL
     AND COALESCE(a.correction_status,'none') <> 'pending'
     AND a.status NOT IN ('on_leave','holiday','absent');

  SELECT jsonb_object_agg(t.code, sub.totals)
    INTO v_types
    FROM (
      SELECT work_entry_type_id,
             jsonb_build_object(
               'hours', ROUND(SUM(hours)::numeric, 2),
               'overtime_hours', ROUND(SUM(overtime_hours)::numeric, 2),
               'rows', COUNT(*)
             ) AS totals
        FROM public.payroll_work_entries
       WHERE payroll_run_id = _run_id
         AND work_entry_type_id IS NOT NULL
       GROUP BY work_entry_type_id
    ) sub
    JOIN public.payroll_work_entry_types t ON t.id = sub.work_entry_type_id;

  SELECT COUNT(DISTINCT employee_id) INTO v_employees
    FROM public.payroll_work_entries WHERE payroll_run_id = _run_id;

  RETURN jsonb_build_object(
    'employees', v_employees,
    'by_type', COALESCE(v_types, '{}'::jsonb),
    'sources_used', to_jsonb(v_sources),
    'locked_attendance_rows', v_locked,
    'preapproval_gate', v_require_preapproval
  );
END
$function$;

-- 4) Add leave_types.work_entry_type_id so tenants can classify each leave
--    type (annual / sick / maternity / bereavement) into the WET of their
--    choice. Nullable — the projector falls back to the paid/unpaid split.
ALTER TABLE public.leave_types
  ADD COLUMN IF NOT EXISTS work_entry_type_id uuid
    REFERENCES public.payroll_work_entry_types(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_leave_types_wet
  ON public.leave_types(work_entry_type_id) WHERE work_entry_type_id IS NOT NULL;
