-- =========================================================
-- WAVE 3 — Governance Orchestrator + Immutable Audit Trail
-- =========================================================

-- ---------------------------------------------------------
-- governance_events: append-only audit trail for every
-- privileged teardown / export job. Its own immutability
-- trigger does NOT honour the teardown bypass — governance
-- audit history is permanent by design.
-- ---------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.governance_events (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  event_type      text NOT NULL, -- 'teardown' | 'export' | 'reset_module'
  module_keys     text[] NOT NULL DEFAULT ARRAY[]::text[],
  actor_id        uuid,
  payload         jsonb NOT NULL DEFAULT '{}'::jsonb,
  result          jsonb,
  succeeded       boolean,
  error_message   text,
  started_at      timestamptz NOT NULL DEFAULT now(),
  finished_at     timestamptz
);

CREATE INDEX IF NOT EXISTS governance_events_org_idx
  ON public.governance_events(organization_id, started_at DESC);

ALTER TABLE public.governance_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS governance_events_read_admin ON public.governance_events;
CREATE POLICY governance_events_read_admin
  ON public.governance_events FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.user_roles ur
      WHERE ur.user_id = auth.uid()
        AND ur.organization_id = governance_events.organization_id
        AND COALESCE(ur.is_active, true) = true
        AND ur.role IN ('super_admin','owner','admin')
    )
  );

DROP POLICY IF EXISTS governance_events_no_client_write ON public.governance_events;
CREATE POLICY governance_events_no_client_write
  ON public.governance_events AS RESTRICTIVE
  FOR ALL TO authenticated USING (false) WITH CHECK (false);

-- Immutability trigger — explicitly does NOT honour the teardown bypass.
CREATE OR REPLACE FUNCTION public.enforce_governance_events_immutable()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'governance_events is append-only; deletes are forbidden (id=%)', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    -- Allow only filling result/finished_at/succeeded/error_message after the fact.
    IF NEW.organization_id IS DISTINCT FROM OLD.organization_id
       OR NEW.event_type    IS DISTINCT FROM OLD.event_type
       OR NEW.module_keys   IS DISTINCT FROM OLD.module_keys
       OR NEW.actor_id      IS DISTINCT FROM OLD.actor_id
       OR NEW.payload       IS DISTINCT FROM OLD.payload
       OR NEW.started_at    IS DISTINCT FROM OLD.started_at
    THEN
      RAISE EXCEPTION 'governance_events row % is immutable; only result/finished_at/succeeded/error_message may be set.', OLD.id
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$;

DROP TRIGGER IF EXISTS trg_governance_events_immutable ON public.governance_events;
CREATE TRIGGER trg_governance_events_immutable
  BEFORE UPDATE OR DELETE ON public.governance_events
  FOR EACH ROW EXECUTE FUNCTION public.enforce_governance_events_immutable();

-- ---------------------------------------------------------
-- governance_run_teardown — the dependency-aware orchestrator.
-- Topo-sorts modules via `depends_on`, refuses unsafe partial
-- selections, runs each module's reset_fn under the teardown
-- context, and records the result in governance_events.
-- ---------------------------------------------------------
CREATE OR REPLACE FUNCTION public.governance_run_teardown(
  p_org_id         uuid,
  p_modules        text[],
  p_confirmation   text,
  p_backup_first   boolean DEFAULT false
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller        uuid := auth.uid();
  v_event_id      uuid;
  v_org_name      text;
  v_module        record;
  v_missing_deps  text[];
  v_ordered       text[] := ARRAY[]::text[];
  v_ran           jsonb  := '[]'::jsonb;
  v_skipped       jsonb  := '[]'::jsonb;
  v_dep           text;
  v_remaining     text[] := p_modules;
  v_next          text;
  v_progress      boolean;
  v_sql           text;
  v_result        jsonb;
BEGIN
  -- 1. Authz: only owner/admin/super_admin of the org.
  IF v_caller IS NULL THEN
    RAISE EXCEPTION 'governance_unauthenticated' USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.user_roles ur
    WHERE ur.user_id = v_caller
      AND ur.organization_id = p_org_id
      AND COALESCE(ur.is_active, true) = true
      AND ur.role IN ('super_admin','owner','admin')
  ) THEN
    RAISE EXCEPTION 'governance_forbidden: caller lacks admin role on this organization'
      USING ERRCODE = '42501';
  END IF;

  -- 2. Confirmation token.
  SELECT name INTO v_org_name FROM public.organizations WHERE id = p_org_id;
  IF v_org_name IS NULL THEN
    RAISE EXCEPTION 'governance_org_not_found' USING ERRCODE = '42704';
  END IF;
  IF COALESCE(p_confirmation, '') <> ('RESET ' || v_org_name) THEN
    RAISE EXCEPTION 'governance_bad_confirmation: expected "RESET %"', v_org_name
      USING ERRCODE = '42501';
  END IF;

  -- 3. Validate every requested module is registered.
  FOR v_module IN
    SELECT m.module_key, m.depends_on, m.teardown_fn
    FROM unnest(p_modules) AS req(key)
    LEFT JOIN public.governance_modules m ON m.module_key = req.key AND m.is_active = true
    WHERE m.module_key IS NULL
  LOOP
    RAISE EXCEPTION 'governance_unknown_module: %', v_module.module_key
      USING ERRCODE = '22023';
  END LOOP;

  -- 4. Dependency-closure check: every module's depends_on must
  --    also be in p_modules (otherwise FK/orphan risk).
  SELECT array_agg(DISTINCT dep) INTO v_missing_deps
  FROM (
    SELECT unnest(m.depends_on) AS dep
    FROM public.governance_modules m
    WHERE m.module_key = ANY(p_modules) AND m.is_active = true
  ) deps
  WHERE deps.dep IS NOT NULL AND NOT (deps.dep = ANY(p_modules));

  IF v_missing_deps IS NOT NULL AND array_length(v_missing_deps, 1) > 0 THEN
    RAISE EXCEPTION
      'governance_unsafe_partial: selection would orphan dependent ledger projections. Missing modules: %. Include them or run "Wipe All Transactional Data" instead.',
      array_to_string(v_missing_deps, ', ')
      USING ERRCODE = 'check_violation';
  END IF;

  -- 5. Topological sort (Kahn's algorithm) over the selection.
  --    We delete in REVERSE topological order — dependents first.
  WHILE COALESCE(array_length(v_remaining, 1), 0) > 0 LOOP
    v_progress := false;
    FOR v_next IN SELECT unnest(v_remaining) LOOP
      -- Pick any module whose deps (restricted to the selection)
      -- have all been emitted into v_ordered already.
      IF NOT EXISTS (
        SELECT 1
        FROM public.governance_modules m,
             unnest(m.depends_on) AS d
        WHERE m.module_key = v_next
          AND d = ANY(v_remaining)
      ) THEN
        v_ordered := array_append(v_ordered, v_next);
        v_remaining := array_remove(v_remaining, v_next);
        v_progress := true;
        EXIT;
      END IF;
    END LOOP;
    IF NOT v_progress THEN
      RAISE EXCEPTION 'governance_cycle_detected: cannot topologically sort modules %',
        array_to_string(v_remaining, ', ')
        USING ERRCODE = 'check_violation';
    END IF;
  END LOOP;

  -- Reverse for delete: dependents come out last in the build, so
  -- they must be wiped first.
  v_ordered := (
    SELECT array_agg(x ORDER BY ord DESC)
    FROM unnest(v_ordered) WITH ORDINALITY AS t(x, ord)
  );

  -- 6. Insert the audit event up-front so the run is recorded
  --    even on partial failure.
  INSERT INTO public.governance_events (
    organization_id, event_type, module_keys, actor_id, payload
  ) VALUES (
    p_org_id, 'teardown', v_ordered, v_caller,
    jsonb_build_object(
      'requested', p_modules,
      'ordered_for_delete', v_ordered,
      'backup_first', p_backup_first,
      'confirmation', p_confirmation
    )
  ) RETURNING id INTO v_event_id;

  -- 7. Enter privileged teardown context (txn-local).
  PERFORM set_config('app.reset_in_progress', p_org_id::text, true);

  -- 8. Execute each module's teardown function.
  FOR v_module IN
    SELECT key AS module_key, m.teardown_fn
    FROM unnest(v_ordered) WITH ORDINALITY AS t(key, ord)
    JOIN public.governance_modules m ON m.module_key = t.key
    ORDER BY t.ord
  LOOP
    IF v_module.teardown_fn IS NULL THEN
      v_skipped := v_skipped || jsonb_build_object(
        'module', v_module.module_key,
        'reason', 'no teardown_fn registered'
      );
      CONTINUE;
    END IF;

    BEGIN
      v_sql := format('SELECT public.%I($1)', v_module.teardown_fn);
      EXECUTE v_sql INTO v_result USING p_org_id;
      v_ran := v_ran || jsonb_build_object(
        'module', v_module.module_key,
        'fn', v_module.teardown_fn,
        'result', COALESCE(v_result, '{}'::jsonb)
      );
    EXCEPTION WHEN OTHERS THEN
      -- Record failure in the audit, then re-raise to abort the txn.
      UPDATE public.governance_events
         SET succeeded     = false,
             finished_at   = now(),
             error_message = format('module=%s sqlstate=%s message=%s',
                                    v_module.module_key, SQLSTATE, SQLERRM),
             result        = jsonb_build_object(
                               'ran', v_ran, 'skipped', v_skipped,
                               'failed_module', v_module.module_key
                             )
       WHERE id = v_event_id;
      RAISE;
    END;
  END LOOP;

  -- 9. Mark event as succeeded.
  UPDATE public.governance_events
     SET succeeded   = true,
         finished_at = now(),
         result      = jsonb_build_object(
                         'ran', v_ran,
                         'skipped', v_skipped,
                         'ordered_for_delete', v_ordered
                       )
   WHERE id = v_event_id;

  RETURN jsonb_build_object(
    'ok', true,
    'event_id', v_event_id,
    'ran', v_ran,
    'skipped', v_skipped,
    'ordered_for_delete', v_ordered
  );
END;
$$;

REVOKE ALL ON FUNCTION public.governance_run_teardown(uuid, text[], text, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.governance_run_teardown(uuid, text[], text, boolean) TO authenticated;

-- =========================================================
-- WAVE 4 — Export Center foundation
-- =========================================================

CREATE TABLE IF NOT EXISTS public.governance_export_jobs (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  requested_by    uuid,
  module_keys     text[] NOT NULL DEFAULT ARRAY[]::text[],
  status          text NOT NULL DEFAULT 'pending', -- pending | running | completed | failed
  started_at      timestamptz NOT NULL DEFAULT now(),
  finished_at     timestamptz,
  manifest_path   text,
  sha256          text,
  row_counts      jsonb NOT NULL DEFAULT '{}'::jsonb,
  error_message   text,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS governance_export_jobs_org_idx
  ON public.governance_export_jobs(organization_id, started_at DESC);

ALTER TABLE public.governance_export_jobs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS governance_export_jobs_read_admin ON public.governance_export_jobs;
CREATE POLICY governance_export_jobs_read_admin
  ON public.governance_export_jobs FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.user_roles ur
      WHERE ur.user_id = auth.uid()
        AND ur.organization_id = governance_export_jobs.organization_id
        AND COALESCE(ur.is_active, true) = true
        AND ur.role IN ('super_admin','owner','admin')
    )
  );

DROP POLICY IF EXISTS governance_export_jobs_no_client_write ON public.governance_export_jobs;
CREATE POLICY governance_export_jobs_no_client_write
  ON public.governance_export_jobs AS RESTRICTIVE
  FOR ALL TO authenticated USING (false) WITH CHECK (false);

-- Private storage bucket for the actual export bundles.
INSERT INTO storage.buckets (id, name, public)
VALUES ('governance-exports', 'governance-exports', false)
ON CONFLICT (id) DO NOTHING;

-- Org admins can read their own org's export objects (path layout: <org_id>/<job_id>/...).
DROP POLICY IF EXISTS "governance_exports_read_admin" ON storage.objects;
CREATE POLICY "governance_exports_read_admin"
  ON storage.objects FOR SELECT TO authenticated
  USING (
    bucket_id = 'governance-exports'
    AND EXISTS (
      SELECT 1 FROM public.user_roles ur
      WHERE ur.user_id = auth.uid()
        AND ur.organization_id::text = split_part(name, '/', 1)
        AND COALESCE(ur.is_active, true) = true
        AND ur.role IN ('super_admin','owner','admin')
    )
  );

-- Writes are service-role only (no policy = no access for authenticated role).