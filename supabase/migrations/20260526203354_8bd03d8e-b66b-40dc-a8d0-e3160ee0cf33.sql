
-- Audit table for every storage-gc invocation
CREATE TABLE public.storage_gc_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scope text NOT NULL CHECK (scope IN ('organization','user','entity','orphan')),
  target_id text,
  dry_run boolean NOT NULL DEFAULT false,
  objects_resolved integer NOT NULL DEFAULT 0,
  objects_removed integer NOT NULL DEFAULT 0,
  bytes_freed bigint NOT NULL DEFAULT 0,
  per_bucket jsonb NOT NULL DEFAULT '{}'::jsonb,
  errors jsonb NOT NULL DEFAULT '[]'::jsonb,
  triggered_by uuid,
  trigger_source text NOT NULL DEFAULT 'manual',
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);

CREATE INDEX storage_gc_runs_started_at_idx ON public.storage_gc_runs (started_at DESC);
CREATE INDEX storage_gc_runs_scope_idx ON public.storage_gc_runs (scope, started_at DESC);

GRANT SELECT ON public.storage_gc_runs TO authenticated;
GRANT ALL ON public.storage_gc_runs TO service_role;

ALTER TABLE public.storage_gc_runs ENABLE ROW LEVEL SECURITY;

-- Platform admins (and only platform admins) can see GC history
CREATE POLICY "Platform admins read storage_gc_runs"
  ON public.storage_gc_runs FOR SELECT
  TO authenticated
  USING (public.is_platform_admin(auth.uid()));

-- Resolver: returns the (bucket, name) pairs that belong to the requested scope
CREATE OR REPLACE FUNCTION public.storage_gc_resolve_objects(
  p_scope text,
  p_target_id text DEFAULT NULL
)
RETURNS TABLE(bucket_id text, object_name text, owner_kind text, organization_id uuid, owner_user_id uuid, entity_id text)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF p_scope NOT IN ('organization','user','entity','orphan') THEN
    RAISE EXCEPTION 'Invalid scope: %', p_scope;
  END IF;

  IF p_scope IN ('organization','user','entity') AND p_target_id IS NULL THEN
    RAISE EXCEPTION 'target_id required for scope %', p_scope;
  END IF;

  RETURN QUERY
  SELECT o.bucket_id, o.object_name, o.owner_kind, o.organization_id, o.owner_user_id, o.entity_id
  FROM public.storage_object_ownership o
  WHERE
    CASE p_scope
      WHEN 'organization' THEN o.organization_id = p_target_id::uuid
      WHEN 'user'         THEN o.owner_user_id   = p_target_id::uuid
      WHEN 'entity'       THEN o.entity_id       = p_target_id
      WHEN 'orphan' THEN
        o.inferred_at < now() - interval '7 days'
        AND (
          (o.organization_id IS NOT NULL
            AND NOT EXISTS (SELECT 1 FROM public.organizations org WHERE org.id = o.organization_id))
          OR
          (o.owner_kind = 'user' AND o.owner_user_id IS NOT NULL
            AND NOT EXISTS (SELECT 1 FROM auth.users u WHERE u.id = o.owner_user_id))
        )
    END;
END;
$$;

-- Resolver is service-role only (called from the storage-gc edge function)
REVOKE ALL ON FUNCTION public.storage_gc_resolve_objects(text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.storage_gc_resolve_objects(text, text) FROM authenticated, anon;
GRANT EXECUTE ON FUNCTION public.storage_gc_resolve_objects(text, text) TO service_role;
