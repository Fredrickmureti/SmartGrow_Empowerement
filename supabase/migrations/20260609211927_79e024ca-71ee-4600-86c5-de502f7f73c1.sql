
-- 1. Settings knob (mirrors impossible_travel_action)
ALTER TABLE public.attendance_settings
  ADD COLUMN IF NOT EXISTS device_trust_action text NOT NULL DEFAULT 'flag'
    CHECK (device_trust_action IN ('flag','deny'));

-- 2. Review fields on attendance
ALTER TABLE public.attendance
  ADD COLUMN IF NOT EXISTS requires_review boolean NOT NULL DEFAULT false;
ALTER TABLE public.attendance
  ADD COLUMN IF NOT EXISTS review_reasons text[] NOT NULL DEFAULT '{}';

-- 3. Rewrite attendance_clock_in
CREATE OR REPLACE FUNCTION public.attendance_clock_in(_employee_id uuid, _branch_id uuid DEFAULT NULL::uuid, _source text DEFAULT 'web'::text, _location jsonb DEFAULT NULL::jsonb, _lat numeric DEFAULT NULL::numeric, _lng numeric DEFAULT NULL::numeric, _accuracy_m numeric DEFAULT NULL::numeric, _device_fp text DEFAULT NULL::text, _user_agent text DEFAULT NULL::text, _selfie_path text DEFAULT NULL::text, _kiosk_pin text DEFAULT NULL::text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
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
  v_review_reasons text[] := ARRAY[]::text[];
  v_device_action text;
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
  v_business := COALESCE(
    v_emp.business_id,
    (SELECT business_id FROM public.branches WHERE id = v_branch)
  );
  IF v_business IS NULL THEN
    RAISE EXCEPTION 'EMPLOYEE_BUSINESS_UNRESOLVED';
  END IF;

  SELECT * INTO v_settings FROM public.attendance_settings WHERE business_id = v_business LIMIT 1;
  v_device_action := COALESCE(v_settings.device_trust_action, 'flag');

  -- ALREADY_CLOCKED_IN
  SELECT id INTO v_open FROM public.attendance
    WHERE employee_id = _employee_id AND clock_out IS NULL LIMIT 1;
  IF v_open IS NOT NULL THEN v_deny := 'ALREADY_CLOCKED_IN'; END IF;

  -- DUPLICATE_RECENT_ATTEMPT
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
      );
      v_seconds_since := GREATEST(1, EXTRACT(EPOCH FROM (v_now - v_last.created_at))::integer);
      v_speed_kmh := (v_distance / 1000.0) / (v_seconds_since / 3600.0);
      IF v_speed_kmh > v_settings.max_speed_kmh THEN
        IF COALESCE(v_settings.impossible_travel_action, 'flag') = 'deny' THEN
          v_deny := 'IMPOSSIBLE_TRAVEL';
        ELSE
          v_review_reasons := v_review_reasons || 'IMPOSSIBLE_TRAVEL';
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

  -- DEVICE TRUST (flag-or-deny, mirrors impossible_travel_action)
  IF v_deny IS NULL AND COALESCE(v_settings.device_binding_required, false) THEN
    IF _device_fp IS NULL THEN
      IF v_device_action = 'deny' THEN
        v_deny := 'UNTRUSTED_DEVICE';
      ELSE
        v_review_reasons := v_review_reasons || 'NO_DEVICE_FINGERPRINT';
      END IF;
    ELSE
      SELECT * INTO v_trust FROM public.attendance_device_trust
        WHERE employee_id = _employee_id AND device_fingerprint = _device_fp;
      IF v_trust.id IS NULL THEN
        IF v_device_action = 'deny' THEN
          INSERT INTO public.attendance_device_trust(organization_id, employee_id, device_fingerprint, user_agent)
          VALUES (v_org, _employee_id, _device_fp, _user_agent);
          v_deny := 'UNTRUSTED_DEVICE';
        ELSE
          INSERT INTO public.attendance_device_trust(
            organization_id, employee_id, device_fingerprint, user_agent,
            trusted_at, trusted_by
          ) VALUES (
            v_org, _employee_id, _device_fp, _user_agent,
            v_now, v_user
          );
          v_review_reasons := v_review_reasons || 'NEW_DEVICE_AUTOTRUSTED';
        END IF;
      ELSIF v_trust.revoked_at IS NOT NULL THEN
        v_deny := 'DEVICE_REVOKED';
      ELSIF v_trust.trusted_at IS NULL THEN
        IF v_device_action = 'deny' THEN
          v_deny := 'UNTRUSTED_DEVICE';
        ELSE
          UPDATE public.attendance_device_trust
             SET trusted_at = v_now, trusted_by = v_user, last_seen_at = v_now, updated_at = v_now
           WHERE id = v_trust.id;
          v_review_reasons := v_review_reasons || 'NEW_DEVICE_AUTOTRUSTED';
        END IF;
      ELSE
        UPDATE public.attendance_device_trust SET last_seen_at = v_now WHERE id = v_trust.id;
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
    clock_in_device_fp, clock_in_selfie_path, source, verification_method,
    requires_review, review_reasons
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
    END,
    COALESCE(array_length(v_review_reasons,1),0) > 0,
    v_review_reasons
  ) RETURNING id INTO v_id;

  -- Log a 'flag' event for each review reason raised during this punch
  IF array_length(v_review_reasons,1) > 0 THEN
    DECLARE r text;
    BEGIN
      FOREACH r IN ARRAY v_review_reasons LOOP
        IF r <> 'IMPOSSIBLE_TRAVEL' THEN  -- already logged above
          PERFORM public.attendance_log_event(
            v_org, v_business, v_branch, _employee_id, v_id,
            'clock_in', COALESCE(_source,'web'), 'flag', r,
            _lat, _lng, _accuracy_m, _user_agent, _device_fp, _selfie_path, NULL
          );
        END IF;
      END LOOP;
    END;
  END IF;

  PERFORM public.attendance_log_event(
    v_org, v_business, v_branch, _employee_id, v_id,
    'clock_in', COALESCE(_source,'web'), 'allow', NULL,
    _lat, _lng, _accuracy_m, _user_agent, _device_fp, _selfie_path, NULL
  );

  RETURN v_id;
END $function$;
