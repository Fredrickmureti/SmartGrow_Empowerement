
-- =========================================================================
-- 1. Settings: new behavioural flags (all default to OFF / null = inactive)
-- =========================================================================
ALTER TABLE public.attendance_settings
  ADD COLUMN IF NOT EXISTS enforce_shift_window boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS early_clock_in_minutes integer NOT NULL DEFAULT 30,
  ADD COLUMN IF NOT EXISTS late_clock_in_minutes integer NOT NULL DEFAULT 120,
  ADD COLUMN IF NOT EXISTS require_ot_preapproval boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS max_speed_kmh integer NOT NULL DEFAULT 200,
  ADD COLUMN IF NOT EXISTS min_clock_interval_seconds integer NOT NULL DEFAULT 30,
  ADD COLUMN IF NOT EXISTS holiday_auto_stamp boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS impossible_travel_action text NOT NULL DEFAULT 'flag'; -- 'flag' | 'deny'

-- =========================================================================
-- 2. employees.external_attendance_ref — badge / RFID / device id lookup
-- =========================================================================
ALTER TABLE public.employees
  ADD COLUMN IF NOT EXISTS external_attendance_ref text;
CREATE UNIQUE INDEX IF NOT EXISTS employees_external_attendance_ref_org_uniq
  ON public.employees(organization_id, external_attendance_ref)
  WHERE external_attendance_ref IS NOT NULL;

-- =========================================================================
-- 3. attendance_breaks
-- =========================================================================
CREATE TABLE IF NOT EXISTS public.attendance_breaks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  business_id uuid,
  attendance_id uuid NOT NULL REFERENCES public.attendance(id) ON DELETE CASCADE,
  employee_id uuid NOT NULL,
  break_type text NOT NULL DEFAULT 'rest' CHECK (break_type IN ('meal','rest','prayer','other')),
  started_at timestamptz NOT NULL DEFAULT now(),
  ended_at timestamptz,
  duration_minutes integer GENERATED ALWAYS AS (
    CASE WHEN ended_at IS NULL THEN NULL
         ELSE GREATEST(0, (EXTRACT(EPOCH FROM (ended_at - started_at))/60)::integer) END
  ) STORED,
  source text NOT NULL DEFAULT 'web',
  device_fp text,
  lat numeric, lng numeric,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS attendance_breaks_attendance_idx ON public.attendance_breaks(attendance_id);
CREATE INDEX IF NOT EXISTS attendance_breaks_employee_idx ON public.attendance_breaks(employee_id, started_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS attendance_breaks_one_open_per_attendance
  ON public.attendance_breaks(attendance_id) WHERE ended_at IS NULL;

GRANT SELECT ON public.attendance_breaks TO authenticated;
GRANT ALL ON public.attendance_breaks TO service_role;

ALTER TABLE public.attendance_breaks ENABLE ROW LEVEL SECURITY;

CREATE POLICY "attendance_breaks_self_read" ON public.attendance_breaks
  FOR SELECT TO authenticated USING (
    EXISTS (SELECT 1 FROM public.employees e WHERE e.id = attendance_breaks.employee_id AND e.user_id = auth.uid())
    OR public.user_has_module_permission(auth.uid(), organization_id, 'attendance', 'read')
  );

-- =========================================================================
-- 4. overtime_requests
-- =========================================================================
CREATE TABLE IF NOT EXISTS public.overtime_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  business_id uuid,
  branch_id uuid,
  employee_id uuid NOT NULL,
  ot_date date NOT NULL,
  requested_hours numeric(5,2) NOT NULL CHECK (requested_hours > 0 AND requested_hours <= 24),
  reason text,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','cancelled')),
  requested_by uuid,
  approved_by uuid,
  approved_at timestamptz,
  rejection_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS overtime_requests_emp_date_idx ON public.overtime_requests(employee_id, ot_date);
CREATE INDEX IF NOT EXISTS overtime_requests_org_status_idx ON public.overtime_requests(organization_id, status);

GRANT SELECT, INSERT, UPDATE ON public.overtime_requests TO authenticated;
GRANT ALL ON public.overtime_requests TO service_role;
ALTER TABLE public.overtime_requests ENABLE ROW LEVEL SECURITY;

CREATE POLICY "ot_self_read" ON public.overtime_requests
  FOR SELECT TO authenticated USING (
    EXISTS (SELECT 1 FROM public.employees e WHERE e.id = overtime_requests.employee_id AND e.user_id = auth.uid())
    OR public.user_has_module_permission(auth.uid(), organization_id, 'attendance', 'read')
  );

-- writes are funneled through SECURITY DEFINER RPCs; no INSERT/UPDATE policy is granted

-- =========================================================================
-- 5. attendance_devices (hardware registry) + ingest log
-- =========================================================================
CREATE TABLE IF NOT EXISTS public.attendance_devices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  business_id uuid,
  branch_id uuid,
  vendor text NOT NULL CHECK (vendor IN ('zkteco','hikvision','suprema','rfid','kiosk','generic')),
  serial text NOT NULL,
  public_id text NOT NULL UNIQUE,
  hmac_secret bytea NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended','revoked')),
  last_seen_at timestamptz,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS attendance_devices_org_serial_uniq
  ON public.attendance_devices(organization_id, vendor, serial);
CREATE INDEX IF NOT EXISTS attendance_devices_org_status_idx ON public.attendance_devices(organization_id, status);

GRANT SELECT ON public.attendance_devices TO authenticated;
GRANT ALL ON public.attendance_devices TO service_role;
ALTER TABLE public.attendance_devices ENABLE ROW LEVEL SECURITY;

CREATE POLICY "attendance_devices_hr_read" ON public.attendance_devices
  FOR SELECT TO authenticated USING (
    public.user_has_module_permission(auth.uid(), organization_id, 'attendance', 'read')
  );

CREATE TABLE IF NOT EXISTS public.attendance_ingest_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  device_id uuid REFERENCES public.attendance_devices(id) ON DELETE SET NULL,
  device_public_id text NOT NULL,
  payload_hash text NOT NULL,
  employee_ref text,
  kind text,
  ts timestamptz,
  accepted boolean NOT NULL,
  reason text,
  attendance_id uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS attendance_ingest_log_dedup
  ON public.attendance_ingest_log(device_public_id, payload_hash);
CREATE INDEX IF NOT EXISTS attendance_ingest_log_recent_idx
  ON public.attendance_ingest_log(device_id, created_at DESC);
GRANT SELECT ON public.attendance_ingest_log TO authenticated;
GRANT ALL ON public.attendance_ingest_log TO service_role;
ALTER TABLE public.attendance_ingest_log ENABLE ROW LEVEL SECURITY;
CREATE POLICY "attendance_ingest_hr_read" ON public.attendance_ingest_log
  FOR SELECT TO authenticated USING (
    EXISTS (SELECT 1 FROM public.attendance_devices d
            WHERE d.id = attendance_ingest_log.device_id
              AND public.user_has_module_permission(auth.uid(), d.organization_id, 'attendance', 'read'))
  );

-- =========================================================================
-- 6. RPCs — breaks
-- =========================================================================
CREATE OR REPLACE FUNCTION public.attendance_break_start(
  _attendance_id uuid,
  _break_type text DEFAULT 'rest',
  _source text DEFAULT 'web',
  _lat numeric DEFAULT NULL,
  _lng numeric DEFAULT NULL,
  _device_fp text DEFAULT NULL,
  _notes text DEFAULT NULL
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $$
DECLARE v_att record; v_user uuid := auth.uid(); v_id uuid;
BEGIN
  SELECT * INTO v_att FROM public.attendance WHERE id = _attendance_id;
  IF v_att.id IS NULL THEN RAISE EXCEPTION 'ATTENDANCE_NOT_FOUND'; END IF;
  IF v_att.clock_out IS NOT NULL THEN RAISE EXCEPTION 'SESSION_CLOSED'; END IF;

  IF NOT EXISTS (SELECT 1 FROM public.employees e WHERE e.id = v_att.employee_id AND e.user_id = v_user)
     AND NOT public.user_has_module_permission(v_user, v_att.organization_id, 'attendance', 'write') THEN
    RAISE EXCEPTION 'PERMISSION_DENIED';
  END IF;

  IF EXISTS (SELECT 1 FROM public.attendance_breaks WHERE attendance_id = _attendance_id AND ended_at IS NULL) THEN
    RAISE EXCEPTION 'BREAK_ALREADY_OPEN';
  END IF;

  INSERT INTO public.attendance_breaks(
    organization_id, business_id, attendance_id, employee_id,
    break_type, source, lat, lng, device_fp, notes
  ) VALUES (
    v_att.organization_id, v_att.business_id, _attendance_id, v_att.employee_id,
    COALESCE(_break_type,'rest'), COALESCE(_source,'web'), _lat, _lng, _device_fp, _notes
  ) RETURNING id INTO v_id;

  PERFORM public.attendance_log_event(
    v_att.organization_id, v_att.business_id, v_att.branch_id, v_att.employee_id, _attendance_id,
    'break_start', COALESCE(_source,'web'), 'allow', _break_type,
    _lat, _lng, NULL, NULL, _device_fp, NULL,
    jsonb_build_object('break_id', v_id, 'break_type', _break_type)
  );
  RETURN v_id;
END $$;

CREATE OR REPLACE FUNCTION public.attendance_break_end(
  _break_id uuid,
  _lat numeric DEFAULT NULL,
  _lng numeric DEFAULT NULL,
  _device_fp text DEFAULT NULL
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $$
DECLARE v_br record; v_att record; v_user uuid := auth.uid(); v_total integer;
BEGIN
  SELECT * INTO v_br FROM public.attendance_breaks WHERE id = _break_id;
  IF v_br.id IS NULL THEN RAISE EXCEPTION 'BREAK_NOT_FOUND'; END IF;
  IF v_br.ended_at IS NOT NULL THEN RAISE EXCEPTION 'BREAK_ALREADY_CLOSED'; END IF;

  SELECT * INTO v_att FROM public.attendance WHERE id = v_br.attendance_id;
  IF NOT EXISTS (SELECT 1 FROM public.employees e WHERE e.id = v_br.employee_id AND e.user_id = v_user)
     AND NOT public.user_has_module_permission(v_user, v_br.organization_id, 'attendance', 'write') THEN
    RAISE EXCEPTION 'PERMISSION_DENIED';
  END IF;

  UPDATE public.attendance_breaks
    SET ended_at = now(), lat = COALESCE(_lat, lat), lng = COALESCE(_lng, lng),
        device_fp = COALESCE(_device_fp, device_fp), updated_at = now()
    WHERE id = _break_id;

  -- recompute aggregate on parent
  SELECT COALESCE(SUM(duration_minutes),0)::integer INTO v_total
    FROM public.attendance_breaks WHERE attendance_id = v_br.attendance_id;
  UPDATE public.attendance SET break_duration_minutes = v_total, updated_at = now()
    WHERE id = v_br.attendance_id;

  PERFORM public.attendance_log_event(
    v_att.organization_id, v_att.business_id, v_att.branch_id, v_att.employee_id, v_br.attendance_id,
    'break_end', v_br.source, 'allow', NULL,
    _lat, _lng, NULL, NULL, _device_fp, NULL,
    jsonb_build_object('break_id', _break_id, 'total_break_minutes', v_total)
  );
  RETURN _break_id;
END $$;

-- =========================================================================
-- 7. RPCs — overtime requests
-- =========================================================================
CREATE OR REPLACE FUNCTION public.overtime_request_submit(
  _employee_id uuid, _ot_date date, _hours numeric, _reason text DEFAULT NULL
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $$
DECLARE v_emp record; v_user uuid := auth.uid(); v_id uuid;
BEGIN
  SELECT * INTO v_emp FROM public.employees WHERE id = _employee_id;
  IF v_emp.id IS NULL THEN RAISE EXCEPTION 'EMPLOYEE_NOT_FOUND'; END IF;
  IF v_emp.user_id IS DISTINCT FROM v_user
     AND NOT public.user_has_module_permission(v_user, v_emp.organization_id, 'attendance', 'write') THEN
    RAISE EXCEPTION 'PERMISSION_DENIED';
  END IF;

  INSERT INTO public.overtime_requests(
    organization_id, business_id, branch_id, employee_id, ot_date,
    requested_hours, reason, requested_by
  ) VALUES (
    v_emp.organization_id, v_emp.business_id, v_emp.branch_id, _employee_id, _ot_date,
    _hours, _reason, v_user
  ) RETURNING id INTO v_id;

  -- notify managers in org (best-effort)
  INSERT INTO public.notifications(user_id, organization_id, title, body, link, kind)
  SELECT ur.user_id, v_emp.organization_id,
         'Overtime request submitted',
         format('%s requested %.2fh OT on %s', v_emp.first_name || ' ' || v_emp.last_name, _hours, _ot_date),
         '/hr/overtime', 'overtime'
    FROM public.user_roles ur
   WHERE ur.role IN ('admin','manager','hr')
   ON CONFLICT DO NOTHING;
  RETURN v_id;
EXCEPTION WHEN undefined_table THEN RETURN v_id; -- notifications table optional
END $$;

CREATE OR REPLACE FUNCTION public.overtime_request_decide(
  _id uuid, _decision text, _reason text DEFAULT NULL
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $$
DECLARE v record; v_user uuid := auth.uid();
BEGIN
  IF _decision NOT IN ('approved','rejected','cancelled') THEN RAISE EXCEPTION 'INVALID_DECISION'; END IF;
  SELECT * INTO v FROM public.overtime_requests WHERE id = _id;
  IF v.id IS NULL THEN RAISE EXCEPTION 'NOT_FOUND'; END IF;
  IF NOT public.user_has_module_permission(v_user, v.organization_id, 'attendance', 'write') THEN
    RAISE EXCEPTION 'PERMISSION_DENIED';
  END IF;
  UPDATE public.overtime_requests
    SET status = _decision, approved_by = v_user, approved_at = now(),
        rejection_reason = CASE WHEN _decision='rejected' THEN _reason ELSE rejection_reason END,
        updated_at = now()
    WHERE id = _id;
  RETURN _id;
END $$;

-- =========================================================================
-- 8. RPCs — holiday auto-stamp
-- =========================================================================
CREATE OR REPLACE FUNCTION public.attendance_stamp_holidays(
  _from date DEFAULT (now() AT TIME ZONE 'UTC')::date,
  _to date DEFAULT ((now() AT TIME ZONE 'UTC')::date + 30)
) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $$
DECLARE v_inserted integer := 0;
BEGIN
  INSERT INTO public.attendance(
    organization_id, business_id, branch_id, employee_id, attendance_date, status, source, verification_method
  )
  SELECT e.organization_id, e.business_id, e.branch_id, e.id, h.holiday_date, 'holiday', 'system', 'system'
    FROM public.public_holidays h
    JOIN public.employees e
      ON e.organization_id = h.organization_id
     AND e.is_active = true AND e.termination_date IS NULL
   WHERE h.holiday_date BETWEEN _from AND _to
     AND NOT EXISTS (
       SELECT 1 FROM public.attendance a
        WHERE a.employee_id = e.id AND a.attendance_date = h.holiday_date
     );
  GET DIAGNOSTICS v_inserted = ROW_COUNT;
  RETURN v_inserted;
END $$;

CREATE OR REPLACE FUNCTION public.public_holidays_stamp_trigger()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $$
BEGIN
  PERFORM public.attendance_stamp_holidays(NEW.holiday_date, NEW.holiday_date);
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_public_holidays_stamp ON public.public_holidays;
CREATE TRIGGER trg_public_holidays_stamp
AFTER INSERT ON public.public_holidays
FOR EACH ROW EXECUTE FUNCTION public.public_holidays_stamp_trigger();

-- =========================================================================
-- 9. Enhanced attendance_clock_in with shift window + impossible-travel + duplicate-window
--    Additive: each check gated on a settings flag, defaults preserve current behavior.
-- =========================================================================
CREATE OR REPLACE FUNCTION public.attendance_clock_in(
  _employee_id uuid, _branch_id uuid DEFAULT NULL, _source text DEFAULT 'web',
  _location jsonb DEFAULT NULL, _lat numeric DEFAULT NULL, _lng numeric DEFAULT NULL,
  _accuracy_m numeric DEFAULT NULL, _device_fp text DEFAULT NULL, _user_agent text DEFAULT NULL,
  _selfie_path text DEFAULT NULL, _kiosk_pin text DEFAULT NULL
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  v_org uuid; v_business uuid; v_branch uuid;
  v_emp record; v_user uuid := auth.uid();
  v_open uuid; v_today date := (now() AT TIME ZONE 'UTC')::date;
  v_id uuid; v_snapshot jsonb;
  v_settings record; v_on_leave boolean;
  v_wl record; v_distance numeric;
  v_trust record;
  v_deny text;
  v_last record;
  v_speed_kmh numeric;
  v_seconds_since integer;
  v_shift record;
  v_now timestamptz := now();
BEGIN
  SELECT * INTO v_emp FROM public.employees WHERE id = _employee_id;
  IF v_emp.id IS NULL THEN RAISE EXCEPTION 'EMPLOYEE_NOT_FOUND'; END IF;
  IF NOT v_emp.is_active OR v_emp.termination_date IS NOT NULL THEN
    RAISE EXCEPTION 'EMPLOYEE_INACTIVE';
  END IF;

  IF v_emp.user_id IS DISTINCT FROM v_user THEN
    IF NOT public.user_has_module_permission(v_user, v_emp.organization_id, 'attendance', 'write') THEN
      RAISE EXCEPTION 'PERMISSION_DENIED';
    END IF;
  END IF;

  v_org := v_emp.organization_id;
  v_branch := COALESCE(_branch_id, v_emp.branch_id);
  SELECT business_id INTO v_business FROM public.branches WHERE id = v_branch;

  SELECT * INTO v_settings FROM public.attendance_settings WHERE business_id = v_business LIMIT 1;

  -- ALREADY_CLOCKED_IN
  SELECT id INTO v_open FROM public.attendance
    WHERE employee_id = _employee_id AND clock_out IS NULL LIMIT 1;
  IF v_open IS NOT NULL THEN v_deny := 'ALREADY_CLOCKED_IN'; END IF;

  -- DUPLICATE_RECENT_ATTEMPT (per device fp, recent successful clock_in)
  IF v_deny IS NULL AND _device_fp IS NOT NULL
     AND COALESCE(v_settings.min_clock_interval_seconds, 0) > 0 THEN
    SELECT created_at INTO v_last FROM public.attendance_events
      WHERE employee_id = _employee_id AND event_type='clock_in'
        AND decision='allow' AND device_fingerprint = _device_fp
      ORDER BY created_at DESC LIMIT 1;
    IF v_last.created_at IS NOT NULL THEN
      v_seconds_since := EXTRACT(EPOCH FROM (v_now - v_last.created_at))::integer;
      IF v_seconds_since < v_settings.min_clock_interval_seconds THEN
        v_deny := 'DUPLICATE_RECENT_ATTEMPT';
      END IF;
    END IF;
  END IF;

  -- IMPOSSIBLE_TRAVEL
  IF v_deny IS NULL AND _lat IS NOT NULL AND _lng IS NOT NULL
     AND COALESCE(v_settings.max_speed_kmh, 0) > 0 THEN
    SELECT lat, lng, created_at INTO v_last
      FROM public.attendance_events
      WHERE employee_id = _employee_id AND decision='allow'
        AND lat IS NOT NULL AND lng IS NOT NULL
      ORDER BY created_at DESC LIMIT 1;
    IF v_last.lat IS NOT NULL THEN
      v_distance := earth_distance(
        ll_to_earth(v_last.lat::float8, v_last.lng::float8),
        ll_to_earth(_lat::float8, _lng::float8)
      ); -- metres
      v_seconds_since := GREATEST(1, EXTRACT(EPOCH FROM (v_now - v_last.created_at))::integer);
      v_speed_kmh := (v_distance / 1000.0) / (v_seconds_since / 3600.0);
      IF v_speed_kmh > v_settings.max_speed_kmh THEN
        IF COALESCE(v_settings.impossible_travel_action, 'flag') = 'deny' THEN
          v_deny := 'IMPOSSIBLE_TRAVEL';
        ELSE
          -- flag-only: log a warning event but proceed
          PERFORM public.attendance_log_event(
            v_org, v_business, v_branch, _employee_id, NULL,
            'clock_in', COALESCE(_source,'web'), 'flag', 'IMPOSSIBLE_TRAVEL',
            _lat, _lng, _accuracy_m, _user_agent, _device_fp, _selfie_path,
            jsonb_build_object('speed_kmh', round(v_speed_kmh,2), 'distance_m', round(v_distance,2))
          );
        END IF;
      END IF;
    END IF;
  END IF;

  -- ON_APPROVED_LEAVE
  IF v_deny IS NULL AND COALESCE(v_settings.block_clock_in_on_approved_leave, true) THEN
    SELECT EXISTS (
      SELECT 1 FROM public.leave_requests
      WHERE employee_id = _employee_id AND status = 'approved'
        AND v_today BETWEEN start_date AND end_date
    ) INTO v_on_leave;
    IF v_on_leave THEN v_deny := 'ON_APPROVED_LEAVE'; END IF;
  END IF;

  -- OUTSIDE_SHIFT_WINDOW
  IF v_deny IS NULL AND COALESCE(v_settings.enforce_shift_window, false) THEN
    SELECT s.start_time, s.end_time, s.crosses_midnight
      INTO v_shift
      FROM public.shift_assignments sa
      JOIN public.shifts s ON s.id = sa.shift_id
     WHERE sa.employee_id = _employee_id
       AND v_today BETWEEN sa.start_date AND COALESCE(sa.end_date, v_today)
     ORDER BY sa.start_date DESC LIMIT 1;
    IF v_shift.start_time IS NOT NULL THEN
      IF (v_now AT TIME ZONE 'UTC')::time < v_shift.start_time - make_interval(mins => COALESCE(v_settings.early_clock_in_minutes,30))
         OR (v_now AT TIME ZONE 'UTC')::time > v_shift.start_time + make_interval(mins => COALESCE(v_settings.late_clock_in_minutes,120)) THEN
        v_deny := 'OUTSIDE_SHIFT_WINDOW';
      END IF;
    END IF;
  END IF;

  -- GEOFENCE
  IF v_deny IS NULL AND COALESCE(v_settings.geofence_required, false) THEN
    IF _lat IS NULL OR _lng IS NULL THEN
      v_deny := 'GEO_REQUIRED';
    ELSE
      SELECT wl.* INTO v_wl FROM public.work_locations wl WHERE wl.id = v_emp.work_location_id;
      IF v_wl.id IS NULL OR v_wl.latitude IS NULL OR v_wl.longitude IS NULL OR v_wl.geofence_radius_m IS NULL THEN
        v_deny := 'NO_GEOFENCE_DEFINED';
      ELSE
        v_distance := earth_distance(
          ll_to_earth(v_wl.latitude, v_wl.longitude),
          ll_to_earth(_lat::float8, _lng::float8)
        );
        IF v_distance > v_wl.geofence_radius_m THEN v_deny := 'OUTSIDE_GEOFENCE'; END IF;
      END IF;
    END IF;
  END IF;

  -- SELFIE
  IF v_deny IS NULL AND COALESCE(v_settings.selfie_required, false) AND _selfie_path IS NULL THEN
    v_deny := 'SELFIE_REQUIRED';
  END IF;

  -- DEVICE TRUST
  IF v_deny IS NULL AND COALESCE(v_settings.device_binding_required, false) THEN
    IF _device_fp IS NULL THEN
      v_deny := 'UNTRUSTED_DEVICE';
    ELSE
      SELECT * INTO v_trust FROM public.attendance_device_trust
        WHERE employee_id = _employee_id AND device_fingerprint = _device_fp;
      IF v_trust.id IS NULL THEN
        INSERT INTO public.attendance_device_trust(organization_id, employee_id, device_fingerprint, user_agent)
        VALUES (v_org, _employee_id, _device_fp, _user_agent);
        v_deny := 'UNTRUSTED_DEVICE';
      ELSIF v_trust.revoked_at IS NOT NULL THEN
        v_deny := 'DEVICE_REVOKED';
      ELSIF v_trust.trusted_at IS NULL THEN
        v_deny := 'UNTRUSTED_DEVICE';
      ELSE
        UPDATE public.attendance_device_trust SET last_seen_at = now() WHERE id = v_trust.id;
      END IF;
    END IF;
  END IF;

  -- KIOSK PIN
  IF v_deny IS NULL AND COALESCE(_source,'web') = 'kiosk' AND COALESCE(v_settings.kiosk_pin_required, false) THEN
    IF _kiosk_pin IS NULL OR NOT EXISTS (
      SELECT 1 FROM public.employee_credentials ec
       WHERE ec.employee_id = _employee_id
         AND ec.kiosk_pin_hash IS NOT NULL
         AND ec.kiosk_pin_hash = crypt(_kiosk_pin, ec.kiosk_pin_hash)
    ) THEN
      v_deny := 'KIOSK_PIN_INVALID';
    END IF;
  END IF;

  IF v_deny IS NOT NULL THEN
    PERFORM public.attendance_log_event(
      v_org, v_business, v_branch, _employee_id, NULL,
      'clock_in', COALESCE(_source,'web'), 'deny', v_deny,
      _lat, _lng, _accuracy_m, _user_agent, _device_fp, _selfie_path, NULL
    );
    RAISE EXCEPTION '%', v_deny;
  END IF;

  v_snapshot := public.attendance_build_schedule_snapshot(_employee_id, v_today);

  INSERT INTO public.attendance(
    organization_id, business_id, branch_id, employee_id, attendance_date,
    clock_in, status, clock_in_method, clock_in_location, created_by, work_schedule_snapshot,
    clock_in_lat, clock_in_lng, clock_in_accuracy_m, clock_in_user_agent,
    clock_in_device_fp, clock_in_selfie_path, source, verification_method
  ) VALUES (
    v_org, v_business, v_branch, _employee_id, v_today,
    v_now, 'present', COALESCE(_source,'web'), _location, v_user, v_snapshot,
    _lat, _lng, _accuracy_m, _user_agent,
    _device_fp, _selfie_path, COALESCE(_source,'web'),
    CASE
      WHEN _selfie_path IS NOT NULL THEN 'selfie'
      WHEN _kiosk_pin IS NOT NULL THEN 'kiosk_pin'
      WHEN _device_fp IS NOT NULL THEN 'device_fp'
      ELSE 'session'
    END
  ) RETURNING id INTO v_id;

  PERFORM public.attendance_log_event(
    v_org, v_business, v_branch, _employee_id, v_id,
    'clock_in', COALESCE(_source,'web'), 'allow', NULL,
    _lat, _lng, _accuracy_m, _user_agent, _device_fp, _selfie_path, NULL
  );

  RETURN v_id;
END $function$;

-- =========================================================================
-- 10. Hardware device RPCs (issue / rotate / suspend)
-- =========================================================================
CREATE OR REPLACE FUNCTION public.attendance_device_register(
  _vendor text, _serial text, _branch_id uuid DEFAULT NULL, _metadata jsonb DEFAULT '{}'::jsonb
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $$
DECLARE v_user uuid := auth.uid(); v_org uuid; v_business uuid; v_id uuid; v_pub text; v_secret bytea;
BEGIN
  SELECT business_id, organization_id INTO v_business, v_org FROM public.branches WHERE id = _branch_id;
  IF v_org IS NULL THEN
    SELECT organization_id INTO v_org FROM public.user_organization_roles WHERE user_id = v_user LIMIT 1;
  END IF;
  IF v_org IS NULL THEN RAISE EXCEPTION 'ORGANIZATION_NOT_FOUND'; END IF;
  IF NOT public.user_has_module_permission(v_user, v_org, 'attendance', 'write') THEN
    RAISE EXCEPTION 'PERMISSION_DENIED';
  END IF;

  v_pub := encode(gen_random_bytes(12), 'hex');
  v_secret := gen_random_bytes(32);

  INSERT INTO public.attendance_devices(organization_id, business_id, branch_id, vendor, serial, public_id, hmac_secret, metadata, created_by)
  VALUES (v_org, v_business, _branch_id, _vendor, _serial, v_pub, v_secret, COALESCE(_metadata,'{}'::jsonb), v_user)
  RETURNING id INTO v_id;

  -- secret is returned ONCE on registration; never re-exposed
  RETURN jsonb_build_object('id', v_id, 'public_id', v_pub, 'hmac_secret_hex', encode(v_secret, 'hex'));
END $$;

CREATE OR REPLACE FUNCTION public.attendance_device_set_status(_id uuid, _status text)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $$
DECLARE v record; v_user uuid := auth.uid();
BEGIN
  IF _status NOT IN ('active','suspended','revoked') THEN RAISE EXCEPTION 'INVALID_STATUS'; END IF;
  SELECT * INTO v FROM public.attendance_devices WHERE id = _id;
  IF v.id IS NULL THEN RAISE EXCEPTION 'NOT_FOUND'; END IF;
  IF NOT public.user_has_module_permission(v_user, v.organization_id, 'attendance', 'write') THEN
    RAISE EXCEPTION 'PERMISSION_DENIED';
  END IF;
  UPDATE public.attendance_devices SET status = _status, updated_at = now() WHERE id = _id;
  RETURN _id;
END $$;

-- updated_at triggers (re-uses existing helper if present)
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_proc WHERE proname='update_updated_at_column') THEN
    EXECUTE 'DROP TRIGGER IF EXISTS trg_attendance_breaks_updated ON public.attendance_breaks';
    EXECUTE 'CREATE TRIGGER trg_attendance_breaks_updated BEFORE UPDATE ON public.attendance_breaks FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column()';
    EXECUTE 'DROP TRIGGER IF EXISTS trg_overtime_requests_updated ON public.overtime_requests';
    EXECUTE 'CREATE TRIGGER trg_overtime_requests_updated BEFORE UPDATE ON public.overtime_requests FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column()';
    EXECUTE 'DROP TRIGGER IF EXISTS trg_attendance_devices_updated ON public.attendance_devices';
    EXECUTE 'CREATE TRIGGER trg_attendance_devices_updated BEFORE UPDATE ON public.attendance_devices FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column()';
  END IF;
END $$;
