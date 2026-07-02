-- B3.3-followup: make attendance_events_search use truthful event_time for filter/order
-- ordering & date-range filters now use COALESCE(event_time, created_at) so UI
-- reflects when the punch actually happened, not when it reached the server.
-- Anti-velocity / dedup RPCs continue to use server created_at (intentional).

DROP FUNCTION IF EXISTS public.attendance_events_search(uuid,uuid,uuid,timestamp with time zone,timestamp with time zone,uuid,text[],text[],text[],integer,timestamp with time zone);

CREATE OR REPLACE FUNCTION public.attendance_events_search(
  _organization_id uuid,
  _business_id uuid DEFAULT NULL,
  _branch_id uuid DEFAULT NULL,
  _from timestamp with time zone DEFAULT NULL,
  _to timestamp with time zone DEFAULT NULL,
  _employee_id uuid DEFAULT NULL,
  _decisions text[] DEFAULT NULL,
  _reasons text[] DEFAULT NULL,
  _event_types text[] DEFAULT NULL,
  _limit integer DEFAULT 200,
  _before timestamp with time zone DEFAULT NULL
)
RETURNS TABLE(
  id uuid, organization_id uuid, business_id uuid, branch_id uuid,
  employee_id uuid, attendance_id uuid, event_type text, source text,
  decision text, reason text, lat numeric, lng numeric, accuracy_m numeric,
  ip inet, user_agent text, device_fingerprint text, selfie_path text,
  metadata jsonb, created_at timestamp with time zone,
  event_time timestamp with time zone, effective_time timestamp with time zone,
  created_by uuid, employee_first_name text, employee_last_name text,
  employee_number text
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
BEGIN
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
    ae.user_agent, ae.device_fingerprint, ae.selfie_path, ae.metadata,
    ae.created_at,
    ae.event_time,
    COALESCE(ae.event_time, ae.created_at) AS effective_time,
    ae.created_by,
    e.first_name, e.last_name, e.employee_number
  FROM public.attendance_events ae
  LEFT JOIN public.employees e ON e.id = ae.employee_id
  WHERE ae.organization_id = _organization_id
    AND (_business_id IS NULL OR ae.business_id = _business_id)
    AND (_branch_id   IS NULL OR ae.branch_id   = _branch_id)
    AND (_employee_id IS NULL OR ae.employee_id = _employee_id)
    AND (_from        IS NULL OR COALESCE(ae.event_time, ae.created_at) >= _from)
    AND (_to          IS NULL OR COALESCE(ae.event_time, ae.created_at) <= _to)
    AND (_decisions   IS NULL OR ae.decision   = ANY(_decisions))
    AND (_reasons     IS NULL OR ae.reason     = ANY(_reasons))
    AND (_event_types IS NULL OR ae.event_type = ANY(_event_types))
    AND (_before      IS NULL OR COALESCE(ae.event_time, ae.created_at) < _before)
  ORDER BY COALESCE(ae.event_time, ae.created_at) DESC
  LIMIT GREATEST(1, LEAST(COALESCE(_limit, 200), 1000));
END;
$function$;

REVOKE ALL ON FUNCTION public.attendance_events_search(uuid,uuid,uuid,timestamp with time zone,timestamp with time zone,uuid,text[],text[],text[],integer,timestamp with time zone) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.attendance_events_search(uuid,uuid,uuid,timestamp with time zone,timestamp with time zone,uuid,text[],text[],text[],integer,timestamp with time zone) TO authenticated;

-- Convenience read view for any future consumer (RLS inherited from base table)
CREATE OR REPLACE VIEW public.v_attendance_events_effective_time AS
SELECT
  ae.*,
  COALESCE(ae.event_time, ae.created_at) AS effective_time
FROM public.attendance_events ae;

GRANT SELECT ON public.v_attendance_events_effective_time TO authenticated;
GRANT ALL    ON public.v_attendance_events_effective_time TO service_role;

COMMENT ON VIEW public.v_attendance_events_effective_time IS
  'Attendance events with effective_time = COALESCE(event_time, created_at). Use for reporting/UI; do NOT use for anti-velocity/dedup which must use server created_at.';