
-- =====================================================================
-- Attendance Phase B: Forensic, geofence, device-trust, append-only events
-- =====================================================================

CREATE EXTENSION IF NOT EXISTS cube;
CREATE EXTENSION IF NOT EXISTS earthdistance;

-- 1) work_locations: geofence columns
ALTER TABLE public.work_locations
  ADD COLUMN IF NOT EXISTS latitude double precision,
  ADD COLUMN IF NOT EXISTS longitude double precision,
  ADD COLUMN IF NOT EXISTS geofence_radius_m integer;

-- 2) attendance_settings: anti-fraud policy flags
ALTER TABLE public.attendance_settings
  ADD COLUMN IF NOT EXISTS geofence_required boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS selfie_required boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS device_binding_required boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS allow_offline_clock boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS max_clock_drift_minutes integer NOT NULL DEFAULT 15;

-- 3) attendance: forensic columns
ALTER TABLE public.attendance
  ADD COLUMN IF NOT EXISTS clock_in_lat numeric,
  ADD COLUMN IF NOT EXISTS clock_in_lng numeric,
  ADD COLUMN IF NOT EXISTS clock_in_accuracy_m numeric,
  ADD COLUMN IF NOT EXISTS clock_in_ip inet,
  ADD COLUMN IF NOT EXISTS clock_in_user_agent text,
  ADD COLUMN IF NOT EXISTS clock_in_device_fp text,
  ADD COLUMN IF NOT EXISTS clock_in_selfie_path text,
  ADD COLUMN IF NOT EXISTS clock_out_lat numeric,
  ADD COLUMN IF NOT EXISTS clock_out_lng numeric,
  ADD COLUMN IF NOT EXISTS clock_out_accuracy_m numeric,
  ADD COLUMN IF NOT EXISTS clock_out_ip inet,
  ADD COLUMN IF NOT EXISTS clock_out_user_agent text,
  ADD COLUMN IF NOT EXISTS clock_out_device_fp text,
  ADD COLUMN IF NOT EXISTS clock_out_selfie_path text,
  ADD COLUMN IF NOT EXISTS source text,
  ADD COLUMN IF NOT EXISTS verification_method text,
  ADD COLUMN IF NOT EXISTS confidence numeric;

-- 4) attendance_device_trust
CREATE TABLE IF NOT EXISTS public.attendance_device_trust (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  employee_id uuid NOT NULL REFERENCES public.employees(id) ON DELETE CASCADE,
  device_fingerprint text NOT NULL,
  label text,
  user_agent text,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  trusted_at timestamptz,
  trusted_by uuid,
  revoked_at timestamptz,
  revoked_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (employee_id, device_fingerprint)
);
GRANT SELECT ON public.attendance_device_trust TO authenticated;
GRANT ALL ON public.attendance_device_trust TO service_role;
ALTER TABLE public.attendance_device_trust ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS adt_self_read ON public.attendance_device_trust;
CREATE POLICY adt_self_read ON public.attendance_device_trust
  FOR SELECT TO authenticated
  USING (
    EXISTS (SELECT 1 FROM public.employees e WHERE e.id = employee_id AND e.user_id = auth.uid())
    OR public.user_has_module_permission(auth.uid(), organization_id, 'attendance', 'read')
  );

CREATE INDEX IF NOT EXISTS idx_adt_employee ON public.attendance_device_trust(employee_id);
CREATE INDEX IF NOT EXISTS idx_adt_org ON public.attendance_device_trust(organization_id);

-- 5) attendance_events: append-only audit log
CREATE TABLE IF NOT EXISTS public.attendance_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  business_id uuid,
  branch_id uuid,
  employee_id uuid NOT NULL,
  attendance_id uuid,
  event_type text NOT NULL,       -- clock_in | clock_out | break_start | break_end | correction | trust_request | trust_approve | trust_revoke
  source text,                    -- web | mobile | kiosk | biometric | rfid | api | import
  decision text NOT NULL,         -- allow | deny
  reason text,                    -- canonical error code on deny
  lat numeric,
  lng numeric,
  accuracy_m numeric,
  ip inet,
  user_agent text,
  device_fingerprint text,
  selfie_path text,
  metadata jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid
);
GRANT SELECT ON public.attendance_events TO authenticated;
GRANT ALL ON public.attendance_events TO service_role;
ALTER TABLE public.attendance_events ENABLE ROW LEVEL SECURITY;

-- Append-only: only service_role / SECURITY DEFINER can insert; nobody can update/delete.
REVOKE INSERT, UPDATE, DELETE ON public.attendance_events FROM authenticated;
REVOKE UPDATE, DELETE ON public.attendance_events FROM service_role;

DROP POLICY IF EXISTS ae_select ON public.attendance_events;
CREATE POLICY ae_select ON public.attendance_events
  FOR SELECT TO authenticated
  USING (
    EXISTS (SELECT 1 FROM public.employees e WHERE e.id = employee_id AND e.user_id = auth.uid())
    OR public.user_has_module_permission(auth.uid(), organization_id, 'attendance', 'read')
  );

-- Hard append-only trigger (belt + suspenders)
CREATE OR REPLACE FUNCTION public.attendance_events_block_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'attendance_events is append-only';
END $$;
DROP TRIGGER IF EXISTS ae_block_update ON public.attendance_events;
CREATE TRIGGER ae_block_update BEFORE UPDATE ON public.attendance_events
  FOR EACH ROW EXECUTE FUNCTION public.attendance_events_block_mutation();
DROP TRIGGER IF EXISTS ae_block_delete ON public.attendance_events;
CREATE TRIGGER ae_block_delete BEFORE DELETE ON public.attendance_events
  FOR EACH ROW EXECUTE FUNCTION public.attendance_events_block_mutation();

CREATE INDEX IF NOT EXISTS idx_ae_org_emp_time
  ON public.attendance_events(organization_id, employee_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ae_decision_time
  ON public.attendance_events(decision, created_at DESC);

-- 6) Internal log helper (SECURITY DEFINER)
CREATE OR REPLACE FUNCTION public.attendance_log_event(
  _organization_id uuid, _business_id uuid, _branch_id uuid, _employee_id uuid,
  _attendance_id uuid, _event_type text, _source text, _decision text, _reason text,
  _lat numeric, _lng numeric, _accuracy_m numeric, _user_agent text,
  _device_fp text, _selfie_path text, _metadata jsonb
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE v_id uuid;
BEGIN
  INSERT INTO public.attendance_events(
    organization_id, business_id, branch_id, employee_id, attendance_id,
    event_type, source, decision, reason,
    lat, lng, accuracy_m, user_agent, device_fingerprint, selfie_path, metadata, created_by
  ) VALUES (
    _organization_id, _business_id, _branch_id, _employee_id, _attendance_id,
    _event_type, _source, _decision, _reason,
    _lat, _lng, _accuracy_m, _user_agent, _device_fp, _selfie_path, _metadata, auth.uid()
  ) RETURNING id INTO v_id;
  RETURN v_id;
END $$;
REVOKE EXECUTE ON FUNCTION public.attendance_log_event(uuid,uuid,uuid,uuid,uuid,text,text,text,text,numeric,numeric,numeric,text,text,text,jsonb) FROM PUBLIC;

-- 7) Rewrite attendance_clock_in with forensic params (backward compatible — all new params default null)
DROP FUNCTION IF EXISTS public.attendance_clock_in(uuid, uuid, text, jsonb);

CREATE OR REPLACE FUNCTION public.attendance_clock_in(
  _employee_id uuid,
  _branch_id uuid DEFAULT NULL,
  _source text DEFAULT 'web',
  _location jsonb DEFAULT NULL,
  _lat numeric DEFAULT NULL,
  _lng numeric DEFAULT NULL,
  _accuracy_m numeric DEFAULT NULL,
  _device_fp text DEFAULT NULL,
  _user_agent text DEFAULT NULL,
  _selfie_path text DEFAULT NULL,
  _kiosk_pin text DEFAULT NULL
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE
  v_org uuid; v_business uuid; v_branch uuid;
  v_emp record; v_user uuid := auth.uid();
  v_open uuid; v_today date := (now() AT TIME ZONE 'UTC')::date;
  v_id uuid; v_snapshot jsonb;
  v_settings record; v_on_leave boolean;
  v_wl record; v_distance numeric;
  v_trust record;
  v_deny text;
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
  IF v_open IS NOT NULL THEN
    v_deny := 'ALREADY_CLOCKED_IN';
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

  -- GEOFENCE
  IF v_deny IS NULL AND COALESCE(v_settings.geofence_required, false) THEN
    IF _lat IS NULL OR _lng IS NULL THEN
      v_deny := 'GEO_REQUIRED';
    ELSE
      SELECT wl.* INTO v_wl FROM public.work_locations wl
        WHERE wl.id = v_emp.work_location_id;
      IF v_wl.id IS NULL OR v_wl.latitude IS NULL OR v_wl.longitude IS NULL OR v_wl.geofence_radius_m IS NULL THEN
        v_deny := 'NO_GEOFENCE_DEFINED';
      ELSE
        v_distance := earth_distance(
          ll_to_earth(v_wl.latitude, v_wl.longitude),
          ll_to_earth(_lat::float8, _lng::float8)
        );
        IF v_distance > v_wl.geofence_radius_m THEN
          v_deny := 'OUTSIDE_GEOFENCE';
        END IF;
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

  -- LOG + RAISE or PROCEED
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
    now(), 'present', COALESCE(_source,'web'), _location, v_user, v_snapshot,
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
END $$;

GRANT EXECUTE ON FUNCTION public.attendance_clock_in(uuid,uuid,text,jsonb,numeric,numeric,numeric,text,text,text,text) TO authenticated, service_role;

-- 8) Rewrite attendance_clock_out with forensic params
DROP FUNCTION IF EXISTS public.attendance_clock_out(uuid, jsonb);

CREATE OR REPLACE FUNCTION public.attendance_clock_out(
  _employee_id uuid,
  _location jsonb DEFAULT NULL,
  _lat numeric DEFAULT NULL,
  _lng numeric DEFAULT NULL,
  _accuracy_m numeric DEFAULT NULL,
  _device_fp text DEFAULT NULL,
  _user_agent text DEFAULT NULL,
  _selfie_path text DEFAULT NULL
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE
  v_user uuid := auth.uid(); v_emp record; v_id uuid; v_row record;
BEGIN
  SELECT * INTO v_emp FROM public.employees WHERE id = _employee_id;
  IF v_emp.id IS NULL THEN RAISE EXCEPTION 'EMPLOYEE_NOT_FOUND'; END IF;

  IF v_emp.user_id IS DISTINCT FROM v_user
     AND NOT public.user_has_module_permission(v_user, v_emp.organization_id, 'attendance', 'write') THEN
    RAISE EXCEPTION 'PERMISSION_DENIED';
  END IF;

  SELECT * INTO v_row FROM public.attendance
    WHERE employee_id = _employee_id AND clock_out IS NULL
    ORDER BY clock_in DESC LIMIT 1;
  IF v_row.id IS NULL THEN RAISE EXCEPTION 'NOT_CLOCKED_IN'; END IF;

  UPDATE public.attendance
    SET clock_out = now(),
        clock_out_location = _location,
        clock_out_lat = _lat,
        clock_out_lng = _lng,
        clock_out_accuracy_m = _accuracy_m,
        clock_out_user_agent = _user_agent,
        clock_out_device_fp = _device_fp,
        clock_out_selfie_path = _selfie_path,
        updated_at = now()
    WHERE id = v_row.id;

  PERFORM public.attendance_log_event(
    v_emp.organization_id, v_row.business_id, v_row.branch_id, _employee_id, v_row.id,
    'clock_out', COALESCE(v_row.source,'web'), 'allow', NULL,
    _lat, _lng, _accuracy_m, _user_agent, _device_fp, _selfie_path, NULL
  );

  RETURN v_row.id;
END $$;

GRANT EXECUTE ON FUNCTION public.attendance_clock_out(uuid,jsonb,numeric,numeric,numeric,text,text,text) TO authenticated, service_role;

-- 9) Device trust mgmt RPCs
CREATE OR REPLACE FUNCTION public.attendance_device_trust_approve(_device_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE v_row record;
BEGIN
  SELECT * INTO v_row FROM public.attendance_device_trust WHERE id = _device_id;
  IF v_row.id IS NULL THEN RAISE EXCEPTION 'NOT_FOUND'; END IF;
  IF NOT public.user_has_module_permission(auth.uid(), v_row.organization_id, 'attendance', 'write') THEN
    RAISE EXCEPTION 'PERMISSION_DENIED';
  END IF;
  UPDATE public.attendance_device_trust
     SET trusted_at = now(), trusted_by = auth.uid(), revoked_at = NULL, revoked_by = NULL, updated_at = now()
   WHERE id = _device_id;
END $$;
GRANT EXECUTE ON FUNCTION public.attendance_device_trust_approve(uuid) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.attendance_device_trust_revoke(_device_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE v_row record;
BEGIN
  SELECT * INTO v_row FROM public.attendance_device_trust WHERE id = _device_id;
  IF v_row.id IS NULL THEN RAISE EXCEPTION 'NOT_FOUND'; END IF;
  IF NOT public.user_has_module_permission(auth.uid(), v_row.organization_id, 'attendance', 'write') THEN
    RAISE EXCEPTION 'PERMISSION_DENIED';
  END IF;
  UPDATE public.attendance_device_trust
     SET revoked_at = now(), revoked_by = auth.uid(), trusted_at = NULL, updated_at = now()
   WHERE id = _device_id;
END $$;
GRANT EXECUTE ON FUNCTION public.attendance_device_trust_revoke(uuid) TO authenticated, service_role;

-- 10) Update settings RPC contract: tolerate new flags (settings table updates flow through existing hook).
