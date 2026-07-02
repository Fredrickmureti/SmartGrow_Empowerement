DROP FUNCTION IF EXISTS public.attendance_events_search(uuid,uuid,uuid,timestamp with time zone,timestamp with time zone,uuid,text[],text[],text[],integer,timestamp with time zone);

CREATE OR REPLACE FUNCTION public.attendance_events_search(_organization_id uuid, _business_id uuid DEFAULT NULL::uuid, _branch_id uuid DEFAULT NULL::uuid, _from timestamp with time zone DEFAULT NULL::timestamp with time zone, _to timestamp with time zone DEFAULT NULL::timestamp with time zone, _employee_id uuid DEFAULT NULL::uuid, _decisions text[] DEFAULT NULL::text[], _reasons text[] DEFAULT NULL::text[], _event_types text[] DEFAULT NULL::text[], _limit integer DEFAULT 200, _before timestamp with time zone DEFAULT NULL::timestamp with time zone)
 RETURNS TABLE(id uuid, organization_id uuid, business_id uuid, branch_id uuid, employee_id uuid, attendance_id uuid, event_type text, source text, decision text, reason text, lat numeric, lng numeric, accuracy_m numeric, ip inet, user_agent text, device_fingerprint text, selfie_path text, metadata jsonb, created_at timestamp with time zone, created_by uuid, employee_first_name text, employee_last_name text, employee_number text)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
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
    ae.user_agent, ae.device_fingerprint, ae.selfie_path, ae.metadata, ae.created_at,
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
$function$;