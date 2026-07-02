-- =======================================================================
-- R3: salary_structure_rule_sets + payslip rule_set_snapshot
-- =======================================================================

CREATE TABLE IF NOT EXISTS public.salary_structure_rule_sets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  structure_id UUID NOT NULL REFERENCES public.salary_structures(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  effective_from DATE NOT NULL,
  effective_to DATE,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('draft','active','superseded')),
  rule_hash TEXT NOT NULL,
  components JSONB NOT NULL,
  created_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(structure_id, version)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_salary_rule_set_active_per_structure
  ON public.salary_structure_rule_sets(structure_id)
  WHERE status='active' AND effective_to IS NULL;

CREATE INDEX IF NOT EXISTS idx_salary_rule_set_structure_effective
  ON public.salary_structure_rule_sets(structure_id, effective_from DESC);

ALTER TABLE public.salary_structure_rule_sets ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "salary_rule_sets_read" ON public.salary_structure_rule_sets;
CREATE POLICY "salary_rule_sets_read" ON public.salary_structure_rule_sets
  FOR SELECT TO authenticated
  USING (user_has_module_permission(auth.uid(), organization_id, 'hr', 'read'));
-- No INSERT/UPDATE/DELETE policies — only the SECURITY DEFINER RPC writes.

-- ─── Payslip stamp columns ───────────────────────────────────────────
ALTER TABLE public.payslips
  ADD COLUMN IF NOT EXISTS rule_set_id UUID REFERENCES public.salary_structure_rule_sets(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS rule_set_version INTEGER,
  ADD COLUMN IF NOT EXISTS rule_set_hash TEXT;

CREATE INDEX IF NOT EXISTS idx_payslips_rule_set
  ON public.payslips(rule_set_id) WHERE rule_set_id IS NOT NULL;

-- payslip_lines.rule_version_id pre-existed (uuid). Add FK if missing.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name='payslip_lines'
       AND column_name='rule_version_id' AND data_type='uuid'
  ) AND NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname='payslip_lines_rule_version_id_fkey'
  ) THEN
    ALTER TABLE public.payslip_lines
      ADD CONSTRAINT payslip_lines_rule_version_id_fkey
      FOREIGN KEY (rule_version_id)
      REFERENCES public.salary_structure_rule_sets(id) ON DELETE SET NULL;
  END IF;
END $$;

-- ─── Canonicaliser (stable sort + key order for hashing) ─────────────
CREATE OR REPLACE FUNCTION public.canonicalise_salary_components(p_structure_id uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE(
    jsonb_agg(
      jsonb_build_object(
        'code', code,
        'name', name,
        'component_type', component_type,
        'computation_type', computation_type,
        'computation_value', computation_value,
        'percentage_of', percentage_of,
        'is_taxable', is_taxable,
        'is_statutory', is_statutory,
        'statutory_rule_type', statutory_rule_type,
        'sort_order', sort_order
      )
      ORDER BY code
    ),
    '[]'::jsonb
  )
  FROM public.salary_components
  WHERE structure_id = p_structure_id AND is_active = true;
$$;

-- ─── Publish RPC ─────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.publish_salary_rule_set(
  p_structure_id uuid,
  p_effective_from date DEFAULT CURRENT_DATE
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_org_id uuid;
  v_canonical jsonb;
  v_hash text;
  v_existing_active RECORD;
  v_new_version int;
  v_new_id uuid;
  v_invoker uuid := auth.uid();
BEGIN
  SELECT organization_id INTO v_org_id
    FROM public.salary_structures
   WHERE id = p_structure_id
   FOR UPDATE;

  IF v_org_id IS NULL THEN
    RAISE EXCEPTION 'salary structure % not found', p_structure_id;
  END IF;

  -- Permission check only for user-invoked calls. service_role / null auth bypass
  -- (engine auto-publish is server-side and already trusted).
  IF v_invoker IS NOT NULL
     AND NOT public.user_has_module_permission(v_invoker, v_org_id, 'hr', 'write') THEN
    RAISE EXCEPTION 'permission denied: hr.write required to publish rule set';
  END IF;

  v_canonical := public.canonicalise_salary_components(p_structure_id);
  IF v_canonical = '[]'::jsonb THEN
    RAISE EXCEPTION 'salary structure % has no active components — nothing to publish', p_structure_id;
  END IF;

  v_hash := encode(extensions.digest(v_canonical::text, 'sha256'), 'hex');

  SELECT id, version, rule_hash, effective_from
    INTO v_existing_active
    FROM public.salary_structure_rule_sets
   WHERE structure_id = p_structure_id
     AND status = 'active'
     AND effective_to IS NULL
   LIMIT 1;

  -- Idempotency: identical hash → no new version.
  IF v_existing_active.id IS NOT NULL AND v_existing_active.rule_hash = v_hash THEN
    RETURN v_existing_active.id;
  END IF;

  IF v_existing_active.id IS NOT NULL THEN
    UPDATE public.salary_structure_rule_sets
       SET status = 'superseded',
           effective_to = GREATEST(p_effective_from - 1, effective_from)
     WHERE id = v_existing_active.id;
  END IF;

  SELECT COALESCE(MAX(version), 0) + 1 INTO v_new_version
    FROM public.salary_structure_rule_sets
   WHERE structure_id = p_structure_id;

  INSERT INTO public.salary_structure_rule_sets (
    organization_id, structure_id, version, effective_from, effective_to,
    status, rule_hash, components, created_by
  ) VALUES (
    v_org_id, p_structure_id, v_new_version, p_effective_from, NULL,
    'active', v_hash, v_canonical, v_invoker
  )
  RETURNING id INTO v_new_id;

  INSERT INTO public.audit_logs (
    organization_id, user_id, action, entity_type, entity_id, entity_name,
    old_values, new_values, changes_summary
  ) VALUES (
    v_org_id, v_invoker, 'create', 'salary_rule_set', v_new_id,
    'rule_set v' || v_new_version,
    CASE WHEN v_existing_active.id IS NOT NULL
         THEN jsonb_build_object('previous_version', v_existing_active.version,
                                 'previous_hash', v_existing_active.rule_hash)
         ELSE NULL END,
    jsonb_build_object('version', v_new_version, 'hash', v_hash,
                       'effective_from', p_effective_from),
    'published rule set v' || v_new_version || ' (hash ' || left(v_hash, 8) || ')'
  );

  RETURN v_new_id;
END;
$$;

REVOKE ALL ON FUNCTION public.publish_salary_rule_set(uuid, date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.publish_salary_rule_set(uuid, date) TO authenticated, service_role;

-- ─── Resolver: returns active rule set as of date, auto-publishes v1 if missing ──
CREATE OR REPLACE FUNCTION public.resolve_or_publish_rule_set(
  p_structure_id uuid,
  p_as_of date
)
RETURNS TABLE(rule_set_id uuid, version int, rule_hash text, components jsonb)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_id uuid; v_ver int; v_hash text; v_comp jsonb;
  v_canonical jsonb;
BEGIN
  SELECT rs.id, rs.version, rs.rule_hash, rs.components
    INTO v_id, v_ver, v_hash, v_comp
    FROM public.salary_structure_rule_sets rs
   WHERE rs.structure_id = p_structure_id
     AND rs.effective_from <= p_as_of
     AND (rs.effective_to IS NULL OR rs.effective_to >= p_as_of)
     AND rs.status IN ('active','superseded')
   ORDER BY rs.effective_from DESC, rs.version DESC
   LIMIT 1;

  IF v_id IS NOT NULL THEN
    rule_set_id := v_id; version := v_ver;
    rule_hash := v_hash; components := v_comp;
    RETURN NEXT;
    RETURN;
  END IF;

  v_canonical := public.canonicalise_salary_components(p_structure_id);
  IF v_canonical = '[]'::jsonb THEN
    RETURN;
  END IF;

  v_id := public.publish_salary_rule_set(p_structure_id, p_as_of);
  SELECT rs.version, rs.rule_hash, rs.components
    INTO v_ver, v_hash, v_comp
    FROM public.salary_structure_rule_sets rs
   WHERE rs.id = v_id;

  rule_set_id := v_id; version := v_ver;
  rule_hash := v_hash; components := v_comp;
  RETURN NEXT;
END;
$$;

REVOKE ALL ON FUNCTION public.resolve_or_publish_rule_set(uuid, date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.resolve_or_publish_rule_set(uuid, date) TO authenticated, service_role;

-- ─── Freeze trigger on salary_components ─────────────────────────────
CREATE OR REPLACE FUNCTION public.salary_components_freeze_when_used()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_structure_id uuid := COALESCE(NEW.structure_id, OLD.structure_id);
  v_has_published boolean;
BEGIN
  SELECT EXISTS(
    SELECT 1 FROM public.salary_structure_rule_sets
     WHERE structure_id = v_structure_id
       AND status IN ('active','superseded')
  ) INTO v_has_published;

  IF v_has_published THEN
    RAISE EXCEPTION
      'salary structure has published rule sets — direct component edits are forbidden'
      USING HINT = 'Editing components after publish would silently change historical payslip computations. Create a new structure or fork the rule set instead.';
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$;

DROP TRIGGER IF EXISTS trg_salary_components_freeze ON public.salary_components;
CREATE TRIGGER trg_salary_components_freeze
  BEFORE INSERT OR UPDATE OR DELETE ON public.salary_components
  FOR EACH ROW EXECUTE FUNCTION public.salary_components_freeze_when_used();

-- ─── Backfill: snapshot v1 + stamp historical payslips ───────────────
DO $$
DECLARE
  r RECORD;
  v_id uuid;
  v_hash text;
  v_canonical jsonb;
  v_org uuid;
BEGIN
  FOR r IN
    SELECT DISTINCT ec.salary_structure_id AS sid,
           MIN(ps.created_at)::date AS oldest
      FROM public.payslips ps
      JOIN public.employee_contracts ec ON ec.employee_id = ps.employee_id
     WHERE ps.rule_set_id IS NULL
       AND ec.salary_structure_id IS NOT NULL
     GROUP BY ec.salary_structure_id
  LOOP
    BEGIN
      -- Skip structures with no active components (legacy / disabled).
      v_canonical := public.canonicalise_salary_components(r.sid);
      IF v_canonical = '[]'::jsonb THEN CONTINUE; END IF;

      -- Skip structures already with a v1 rule set.
      IF EXISTS (SELECT 1 FROM public.salary_structure_rule_sets WHERE structure_id = r.sid) THEN
        CONTINUE;
      END IF;

      SELECT organization_id INTO v_org FROM public.salary_structures WHERE id = r.sid;
      v_hash := encode(extensions.digest(v_canonical::text, 'sha256'), 'hex');

      INSERT INTO public.salary_structure_rule_sets (
        organization_id, structure_id, version, effective_from,
        status, rule_hash, components, created_by
      ) VALUES (v_org, r.sid, 1, r.oldest, 'active', v_hash, v_canonical, NULL)
      RETURNING id INTO v_id;

      UPDATE public.payslips ps
         SET rule_set_id = v_id, rule_set_version = 1, rule_set_hash = v_hash
        FROM public.employee_contracts ec
       WHERE ec.employee_id = ps.employee_id
         AND ec.salary_structure_id = r.sid
         AND ps.rule_set_id IS NULL;
    EXCEPTION WHEN OTHERS THEN
      RAISE NOTICE 'R3 backfill skipped for structure %: %', r.sid, SQLERRM;
    END;
  END LOOP;
END $$;

COMMENT ON TABLE public.salary_structure_rule_sets IS
  'R3: immutable, versioned snapshots of a salary_structure''s active components. compute-payroll resolves the rule set for period_end and stamps payslips/payslip_lines so historical payroll is byte-identical on recompute.';
COMMENT ON FUNCTION public.publish_salary_rule_set(uuid, date) IS
  'R3: snapshots active salary_components for a structure into an immutable rule set version. Idempotent — returns existing id when hash unchanged.';
COMMENT ON FUNCTION public.resolve_or_publish_rule_set(uuid, date) IS
  'R3: returns active rule set for a structure at a given date. Auto-publishes v1 transparently if no rule set exists yet but the structure has active components.';
COMMENT ON FUNCTION public.salary_components_freeze_when_used() IS
  'R3: blocks insert/update/delete on salary_components for any structure that already has a published rule set — prevents silent retroactive payroll changes.';