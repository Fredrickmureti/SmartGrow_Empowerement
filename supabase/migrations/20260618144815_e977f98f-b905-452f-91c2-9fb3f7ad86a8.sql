
-- ============================================================
-- Phase 4: pack_version_id stamping for historical integrity
-- ============================================================

ALTER TABLE public.payroll_runs
  ADD COLUMN IF NOT EXISTS pack_version_id uuid REFERENCES public.pack_versions(id) ON DELETE SET NULL;

ALTER TABLE public.payslips
  ADD COLUMN IF NOT EXISTS pack_version_id uuid REFERENCES public.pack_versions(id) ON DELETE SET NULL;

ALTER TABLE public.payroll_remittances
  ADD COLUMN IF NOT EXISTS pack_version_id uuid REFERENCES public.pack_versions(id) ON DELETE SET NULL;

ALTER TABLE public.payroll_tax_certificates
  ADD COLUMN IF NOT EXISTS pack_version_id uuid REFERENCES public.pack_versions(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_payroll_runs_pack_version_id ON public.payroll_runs(pack_version_id);
CREATE INDEX IF NOT EXISTS idx_payslips_pack_version_id ON public.payslips(pack_version_id);

-- Resolver: returns the rule set as it stood for a payroll run.
-- If pack_version_id is stamped, returns the immutable snapshot;
-- otherwise falls back to live payroll_statutory_rules effective
-- during the run's pay period (legacy, pre-Phase-4 runs).
CREATE OR REPLACE FUNCTION public.resolve_rules_for_run(_run_id uuid)
RETURNS SETOF jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_pvid uuid;
  v_org uuid;
  v_country text;
  v_period_start date;
  v_period_end date;
  v_snapshot jsonb;
BEGIN
  SELECT pack_version_id, organization_id, pay_period_start, pay_period_end
    INTO v_pvid, v_org, v_period_start, v_period_end
    FROM public.payroll_runs WHERE id = _run_id;
  IF NOT FOUND THEN RETURN; END IF;

  IF v_pvid IS NOT NULL THEN
    SELECT snapshot INTO v_snapshot FROM public.pack_versions WHERE id = v_pvid;
    IF v_snapshot IS NOT NULL THEN
      RETURN QUERY
        SELECT jsonb_array_elements(COALESCE(v_snapshot->'payroll_rules', '[]'::jsonb));
      RETURN;
    END IF;
  END IF;

  -- Legacy fallback: live rules effective at run time
  RETURN QUERY
    SELECT to_jsonb(r) FROM public.payroll_statutory_rules r
    WHERE r.organization_id = v_org
      AND r.is_active
      AND r.effective_from <= v_period_end
      AND (r.effective_to IS NULL OR r.effective_to >= v_period_start);
END;
$$;

GRANT EXECUTE ON FUNCTION public.resolve_rules_for_run(uuid) TO authenticated, service_role;

-- ============================================================
-- Phase 5: publisher identity + grants
-- ============================================================

ALTER TABLE public.localization_packs
  ADD COLUMN IF NOT EXISTS publisher_org_id uuid REFERENCES public.organizations(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS publisher_kind text NOT NULL DEFAULT 'platform'
    CHECK (publisher_kind IN ('platform', 'partner'));

CREATE TABLE IF NOT EXISTS public.pack_publisher_grants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  publisher_org_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('owner', 'publisher', 'reviewer')),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  UNIQUE (publisher_org_id, user_id, role)
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.pack_publisher_grants TO authenticated;
GRANT ALL ON public.pack_publisher_grants TO service_role;

ALTER TABLE public.pack_publisher_grants ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "pack_publisher_grants_read" ON public.pack_publisher_grants;
CREATE POLICY "pack_publisher_grants_read" ON public.pack_publisher_grants
  FOR SELECT TO authenticated
  USING (
    user_id = auth.uid()
    OR public.is_platform_admin(auth.uid())
    OR EXISTS (
      SELECT 1 FROM public.pack_publisher_grants g
      WHERE g.publisher_org_id = pack_publisher_grants.publisher_org_id
        AND g.user_id = auth.uid() AND g.role = 'owner'
    )
  );

DROP POLICY IF EXISTS "pack_publisher_grants_write" ON public.pack_publisher_grants;
CREATE POLICY "pack_publisher_grants_write" ON public.pack_publisher_grants
  FOR ALL TO authenticated
  USING (
    public.is_platform_admin(auth.uid())
    OR EXISTS (
      SELECT 1 FROM public.pack_publisher_grants g
      WHERE g.publisher_org_id = pack_publisher_grants.publisher_org_id
        AND g.user_id = auth.uid() AND g.role = 'owner'
    )
  )
  WITH CHECK (
    public.is_platform_admin(auth.uid())
    OR EXISTS (
      SELECT 1 FROM public.pack_publisher_grants g
      WHERE g.publisher_org_id = pack_publisher_grants.publisher_org_id
        AND g.user_id = auth.uid() AND g.role = 'owner'
    )
  );

CREATE OR REPLACE FUNCTION public.is_pack_publisher(_user_id uuid, _pack_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    public.is_platform_admin(_user_id)
    OR EXISTS (
      SELECT 1
      FROM public.localization_packs p
      JOIN public.pack_publisher_grants g ON g.publisher_org_id = p.publisher_org_id
      WHERE p.id = _pack_id
        AND g.user_id = _user_id
        AND g.role IN ('owner', 'publisher')
    );
$$;

GRANT EXECUTE ON FUNCTION public.is_pack_publisher(uuid, uuid) TO authenticated, service_role;

-- ============================================================
-- Phase 6: editor/engine drift guard
-- ============================================================

CREATE OR REPLACE FUNCTION public.enforce_parameters_type_matches_method()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_expected text;
  v_actual text;
BEGIN
  -- Map computation_method → published schema kind. Mirrors
  -- METHOD_TO_KIND in src/components/payroll/StatutoryRuleEditor.tsx.
  v_expected := CASE NEW.computation_method
    WHEN 'bracket_progressive' THEN 'progressive'
    WHEN 'tiered_brackets'     THEN 'tiered'
    WHEN 'percentage_of_gross' THEN 'percentage'
    WHEN 'graduated_table'     THEN 'graduated'
    WHEN 'per_employee_flat'   THEN 'fixed'
    WHEN 'flat_amount'         THEN 'flat'
    ELSE NULL
  END;

  IF v_expected IS NULL THEN
    RETURN NEW; -- unknown methods are soft (legacy_unvalidated)
  END IF;

  v_actual := NEW.parameters->>'type';
  IF v_actual IS NULL THEN
    -- Allow null on insert from legacy code; the editor always sets it.
    RETURN NEW;
  END IF;

  IF v_actual <> v_expected THEN
    RAISE EXCEPTION 'parameters.type (%) does not match computation_method (% → expected %)',
      v_actual, NEW.computation_method, v_expected
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_payroll_statutory_rules_type_match ON public.payroll_statutory_rules;
CREATE TRIGGER trg_payroll_statutory_rules_type_match
  BEFORE INSERT OR UPDATE ON public.payroll_statutory_rules
  FOR EACH ROW EXECUTE FUNCTION public.enforce_parameters_type_matches_method();

-- ============================================================
-- Phase 3: apply_pack_upgrade_atomic
-- ============================================================

CREATE OR REPLACE FUNCTION public.apply_pack_upgrade_atomic(_proposal_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_proposal RECORD;
  v_from_snapshot jsonb;
  v_to_snapshot jsonb;
  v_to_version_id uuid;
  v_actor uuid := auth.uid();
  v_is_admin boolean;
  v_is_member boolean;
  v_diff jsonb := jsonb_build_object('added', '[]'::jsonb, 'modified', '[]'::jsonb, 'removed', '[]'::jsonb, 'conflicts', '[]'::jsonb);
  v_added int := 0;
  v_modified int := 0;
  v_removed int := 0;
  v_conflicts int := 0;
  v_incoming_rule jsonb;
  v_existing RECORD;
  v_rule_code text;
BEGIN
  SELECT * INTO v_proposal FROM public.pack_upgrade_proposals WHERE id = _proposal_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Proposal % not found', _proposal_id USING ERRCODE = 'no_data_found';
  END IF;
  IF v_proposal.status <> 'pending' AND v_proposal.status <> 'proposed' THEN
    RAISE EXCEPTION 'Proposal % is in status % (must be pending/proposed)', _proposal_id, v_proposal.status;
  END IF;

  -- Authorize: platform admin OR organization member
  v_is_admin := public.is_platform_admin(v_actor);
  IF NOT v_is_admin THEN
    SELECT EXISTS (
      SELECT 1 FROM public.user_business_access
      WHERE user_id = v_actor AND business_id = v_proposal.business_id
    ) INTO v_is_member;
    IF NOT v_is_member THEN
      RAISE EXCEPTION 'Not authorized to apply upgrades for this business'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
  END IF;

  -- Resolve from/to snapshots
  SELECT id, snapshot INTO v_to_version_id, v_to_snapshot
    FROM public.pack_versions WHERE pack_id = v_proposal.pack_id AND version = v_proposal.to_version
    ORDER BY published_at DESC NULLS LAST LIMIT 1;
  IF v_to_snapshot IS NULL THEN
    RAISE EXCEPTION 'Target pack version % not found or not published', v_proposal.to_version;
  END IF;

  SELECT snapshot INTO v_from_snapshot
    FROM public.pack_versions WHERE pack_id = v_proposal.pack_id AND version = v_proposal.from_version
    ORDER BY published_at DESC NULLS LAST LIMIT 1;
  v_from_snapshot := COALESCE(v_from_snapshot, '{}'::jsonb);

  -- Iterate incoming payroll rules
  FOR v_incoming_rule IN
    SELECT jsonb_array_elements(COALESCE(v_to_snapshot->'payroll_rules', '[]'::jsonb))
  LOOP
    v_rule_code := v_incoming_rule->>'rule_code';
    IF v_rule_code IS NULL THEN CONTINUE; END IF;

    SELECT * INTO v_existing
      FROM public.payroll_statutory_rules
      WHERE organization_id = v_proposal.organization_id
        AND (business_id = v_proposal.business_id OR (business_id IS NULL AND v_proposal.business_id IS NULL))
        AND rule_code = v_rule_code
      LIMIT 1;

    IF NOT FOUND THEN
      -- ADD
      INSERT INTO public.payroll_statutory_rules
        (organization_id, business_id, country_code, rule_type, rule_name, rule_code,
         computation_method, parameters, effective_from, effective_to, sort_order,
         is_active, base_pack_template_id, base_pack_version)
      VALUES
        (v_proposal.organization_id, v_proposal.business_id,
         COALESCE(v_incoming_rule->>'country_code', ''),
         COALESCE(v_incoming_rule->>'rule_type', 'statutory_deduction'),
         COALESCE(v_incoming_rule->>'rule_name', v_rule_code),
         v_rule_code,
         COALESCE(v_incoming_rule->>'computation_method', 'percentage_of_gross'),
         COALESCE(v_incoming_rule->'parameters', '{}'::jsonb),
         COALESCE((v_incoming_rule->>'effective_from')::date, CURRENT_DATE),
         NULLIF(v_incoming_rule->>'effective_to','')::date,
         COALESCE((v_incoming_rule->>'sort_order')::int, 100),
         true,
         NULLIF(v_incoming_rule->>'template_id','')::uuid,
         v_proposal.to_version);
      v_added := v_added + 1;
      v_diff := jsonb_set(v_diff, '{added}', (v_diff->'added') || jsonb_build_array(v_rule_code));
    ELSIF COALESCE(v_existing.is_tenant_override, false) THEN
      -- CONFLICT: tenant customised this rule; do not overwrite
      INSERT INTO public.pack_rule_conflicts
        (organization_id, business_id, pack_id, from_version, to_version,
         rule_table, rule_id, rule_code, tenant_value, incoming_value, status)
      VALUES
        (v_proposal.organization_id, v_proposal.business_id, v_proposal.pack_id,
         v_proposal.from_version, v_proposal.to_version,
         'payroll_statutory_rules', v_existing.id, v_rule_code,
         to_jsonb(v_existing), v_incoming_rule, 'pending')
      ON CONFLICT DO NOTHING;
      v_conflicts := v_conflicts + 1;
      v_diff := jsonb_set(v_diff, '{conflicts}', (v_diff->'conflicts') || jsonb_build_array(v_rule_code));
    ELSE
      -- MODIFY in place
      UPDATE public.payroll_statutory_rules SET
        rule_name = COALESCE(v_incoming_rule->>'rule_name', rule_name),
        computation_method = COALESCE(v_incoming_rule->>'computation_method', computation_method),
        parameters = COALESCE(v_incoming_rule->'parameters', parameters),
        effective_from = COALESCE((v_incoming_rule->>'effective_from')::date, effective_from),
        effective_to = NULLIF(v_incoming_rule->>'effective_to','')::date,
        base_pack_version = v_proposal.to_version,
        updated_at = now()
      WHERE id = v_existing.id;
      v_modified := v_modified + 1;
      v_diff := jsonb_set(v_diff, '{modified}', (v_diff->'modified') || jsonb_build_array(v_rule_code));
    END IF;
  END LOOP;

  -- REMOVE: rules present in from_snapshot but not in to_snapshot get end-dated (never deleted)
  FOR v_rule_code IN
    SELECT DISTINCT x->>'rule_code'
    FROM jsonb_array_elements(COALESCE(v_from_snapshot->'payroll_rules', '[]'::jsonb)) AS x
    WHERE x->>'rule_code' IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM jsonb_array_elements(COALESCE(v_to_snapshot->'payroll_rules', '[]'::jsonb)) AS y
        WHERE y->>'rule_code' = x->>'rule_code'
      )
  LOOP
    UPDATE public.payroll_statutory_rules
      SET is_active = false,
          effective_to = LEAST(COALESCE(effective_to, CURRENT_DATE), CURRENT_DATE),
          updated_at = now()
      WHERE organization_id = v_proposal.organization_id
        AND (business_id = v_proposal.business_id OR (business_id IS NULL AND v_proposal.business_id IS NULL))
        AND rule_code = v_rule_code
        AND is_active = true;
    IF FOUND THEN
      v_removed := v_removed + 1;
      v_diff := jsonb_set(v_diff, '{removed}', (v_diff->'removed') || jsonb_build_array(v_rule_code));
    END IF;
  END LOOP;

  -- Bump installed_localization_packs to the new version
  UPDATE public.installed_localization_packs
    SET pack_version = v_proposal.to_version, installed_at = now(), installed_by = COALESCE(v_actor, installed_by)
    WHERE organization_id = v_proposal.organization_id
      AND (business_id = v_proposal.business_id OR (business_id IS NULL AND v_proposal.business_id IS NULL))
      AND pack_id = v_proposal.pack_id;

  -- Mark proposal accepted
  UPDATE public.pack_upgrade_proposals
    SET status = 'accepted',
        decided_by = v_actor,
        decided_at = now()
    WHERE id = _proposal_id;

  -- Audit
  INSERT INTO public.pack_migration_log
    (organization_id, business_id, pack_id, pack_version, scope, entity_table, entity_id, reason, before_value, after_value, applied_by)
  VALUES
    (v_proposal.organization_id, v_proposal.business_id, v_proposal.pack_id, v_proposal.to_version,
     'upgrade', 'pack_upgrade_proposals', _proposal_id, 'apply_pack_upgrade_atomic',
     jsonb_build_object('from_version', v_proposal.from_version),
     jsonb_build_object(
       'to_version', v_proposal.to_version,
       'added', v_added,
       'modified', v_modified,
       'removed', v_removed,
       'conflicts', v_conflicts,
       'diff', v_diff
     ),
     v_actor);

  RETURN jsonb_build_object(
    'proposal_id', _proposal_id,
    'from_version', v_proposal.from_version,
    'to_version', v_proposal.to_version,
    'added', v_added,
    'modified', v_modified,
    'removed', v_removed,
    'conflicts', v_conflicts,
    'diff', v_diff
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.apply_pack_upgrade_atomic(uuid) TO authenticated, service_role;
