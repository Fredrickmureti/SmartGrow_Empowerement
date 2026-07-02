-- Phase 4 closeout: holiday hours + audit-events server-side search

ALTER TABLE public.payroll_work_entries
  ADD COLUMN IF NOT EXISTS holiday_hours numeric(10,2) NOT NULL DEFAULT 0;

CREATE OR REPLACE FUNCTION public.attendance_events_search(
  _organization_id uuid,
  _business_id    uuid DEFAULT NULL,
  _branch_id      uuid DEFAULT NULL,
  _from           timestamptz DEFAULT NULL,
  _to             timestamptz DEFAULT NULL,
  _employee_id    uuid DEFAULT NULL,
  _decisions      text[] DEFAULT NULL,   -- e.g. ARRAY['allow','deny']
  _reasons        text[] DEFAULT NULL,   -- canonical error codes
  _event_types    text[] DEFAULT NULL,
  _limit          int  DEFAULT 200,
  _before         timestamptz DEFAULT NULL  -- pagination cursor: created_at < _before
)
RETURNS TABLE (
  id uuid,
  organization_id uuid,
  business_id uuid,
  branch_id uuid,
  employee_id uuid,
  attendance_id uuid,
  event_type text,
  source text,
  decision text,
  reason text,
  lat numeric,
  lng numeric,
  accuracy_m numeric,
  ip inet,
  user_agent text,
  device_fingerprint text,
  metadata jsonb,
  created_at timestamptz,
  created_by uuid,
  employee_first_name text,
  employee_last_name text,
  employee_number text
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Caller must belong to the organization (any role).
  IF NOT EXISTS (
    SELECT 1 FROM public.user_roles ur
    WHERE ur.user_id = auth.uid()
      AND ur.organization_id = _organization_id
  ) THEN
    RAISE EXCEPTION 'NOT_AUTHORIZED' USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  SELECT
    ae.id, ae.organization_id, ae.business_id, ae.branch_id,
    ae.employee_id, ae.attendance_id, ae.event_type, ae.source,
    ae.decision, ae.reason, ae.lat, ae.lng, ae.accuracy_m, ae.ip,
    ae.user_agent, ae.device_fingerprint, ae.metadata, ae.created_at,
    ae.created_by,
    e.first_name, e.last_name, e.employee_number
  FROM public.attendance_events ae
  LEFT JOIN public.employees e ON e.id = ae.employee_id
  WHERE ae.organization_id = _organization_id
    AND (_business_id IS NULL OR ae.business_id = _business_id)
    AND (_branch_id   IS NULL OR ae.branch_id   = _branch_id)
    AND (_employee_id IS NULL OR ae.employee_id = _employee_id)
    AND (_from        IS NULL OR ae.created_at >= _from)
    AND (_to          IS NULL OR ae.created_at <= _to)
    AND (_decisions   IS NULL OR ae.decision = ANY(_decisions))
    AND (_reasons     IS NULL OR ae.reason   = ANY(_reasons))
    AND (_event_types IS NULL OR ae.event_type = ANY(_event_types))
    AND (_before      IS NULL OR ae.created_at < _before)
  ORDER BY ae.created_at DESC
  LIMIT GREATEST(1, LEAST(COALESCE(_limit, 200), 1000));
END;
$$;

REVOKE ALL ON FUNCTION public.attendance_events_search(
  uuid, uuid, uuid, timestamptz, timestamptz, uuid, text[], text[], text[], int, timestamptz
) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.attendance_events_search(
  uuid, uuid, uuid, timestamptz, timestamptz, uuid, text[], text[], text[], int, timestamptz
) TO authenticated;