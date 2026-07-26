CREATE OR REPLACE FUNCTION public.resolve_device(
  _organization_id uuid,
  _role text,
  _business_id uuid DEFAULT NULL,
  _scope_kind text DEFAULT NULL,
  _scope_id uuid DEFAULT NULL
)
RETURNS SETOF public.device_assignments
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  WITH candidates AS (
    SELECT *
      FROM public.device_assignments
     WHERE organization_id = _organization_id
       AND role = _role
       AND enabled = true
  ),
  scoped AS (
    SELECT *
      FROM candidates
     WHERE _scope_kind IS NOT NULL
       AND _scope_kind <> 'tenant'
       AND scope_kind = _scope_kind
       AND scope_id = _scope_id
  ),
  layer1 AS (
    SELECT * FROM scoped
    UNION ALL
    SELECT * FROM candidates
     WHERE NOT EXISTS (SELECT 1 FROM scoped)
  ),
  branch_hits AS (
    SELECT * FROM layer1
     WHERE _business_id IS NOT NULL
       AND business_id = _business_id
  ),
  layer2 AS (
    SELECT * FROM branch_hits
    UNION ALL
    SELECT * FROM layer1
     WHERE NOT EXISTS (SELECT 1 FROM branch_hits)
  )
  SELECT *
    FROM layer2
   ORDER BY is_default DESC NULLS LAST,
            last_seen_at DESC NULLS LAST,
            created_at ASC
   LIMIT 1;
$$;

GRANT EXECUTE ON FUNCTION public.resolve_device(uuid, text, uuid, text, uuid)
  TO authenticated, service_role;

COMMENT ON FUNCTION public.resolve_device(uuid, text, uuid, text, uuid) IS
  'Phase 3 canonical device resolver. Mirrors useDeviceForRole tie-break so server-side callers pick the same physical device the UI picks. Returns SETOF device_assignments (0 or 1 row).';