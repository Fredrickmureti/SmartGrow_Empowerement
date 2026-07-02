-- =====================================================================
-- Phase 3 (continued): resolve all deferred items + KE NITA completeness
-- =====================================================================

-- 1. Register `nita_payable` in the system account roles registry.
INSERT INTO public.system_account_roles (role_key, label, description, required_account_type, is_mandatory, category, sort_order)
SELECT 'nita_payable', 'NITA Payable',
       'National Industrial Training Authority levy payable to the authority',
       'liability', false, 'payroll', 235
WHERE NOT EXISTS (SELECT 1 FROM public.system_account_roles WHERE role_key = 'nita_payable');

-- 2. KE pack: NITA COA templates.
INSERT INTO public.localization_pack_account_templates
  (pack_id, code, name, account_type, role_key, description, sort_order)
SELECT 'a1b2c3d4-e5f6-7890-abcd-ef1234567890'::uuid,
       '2034', 'NITA Payable', 'liability', 'nita_payable',
       'Industrial training levy payable to NITA (KES 50 per employee per month).', 234
WHERE NOT EXISTS (
  SELECT 1 FROM public.localization_pack_account_templates
   WHERE pack_id = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890'::uuid AND role_key = 'nita_payable');

INSERT INTO public.localization_pack_account_templates
  (pack_id, code, name, account_type, role_key, description, sort_order)
SELECT 'a1b2c3d4-e5f6-7890-abcd-ef1234567890'::uuid,
       '6014', 'Employer NITA Contribution', 'expense', 'employer_nita_expense',
       'Employer industrial training levy expense (KES 50 per employee per month).', 614
WHERE NOT EXISTS (
  SELECT 1 FROM public.localization_pack_account_templates
   WHERE pack_id = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890'::uuid AND role_key = 'employer_nita_expense');

-- 3. KE pack required account roles.
INSERT INTO public.pack_account_roles (pack_id, role_key, display_name, account_type, detail_type, description, is_required)
SELECT 'a1b2c3d4-e5f6-7890-abcd-ef1234567890'::uuid, 'nita_payable',
       'NITA Payable', 'liability', 'other_current_liability',
       'Liability account for NITA levy remittances.', true
WHERE NOT EXISTS (
  SELECT 1 FROM public.pack_account_roles
   WHERE pack_id = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890'::uuid AND role_key = 'nita_payable');

INSERT INTO public.pack_account_roles (pack_id, role_key, display_name, account_type, detail_type, description, is_required)
SELECT 'a1b2c3d4-e5f6-7890-abcd-ef1234567890'::uuid, 'employer_nita_expense',
       'Employer NITA Expense', 'expense', NULL,
       'Expense account for the employer-only NITA levy.', true
WHERE NOT EXISTS (
  SELECT 1 FROM public.pack_account_roles
   WHERE pack_id = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890'::uuid AND role_key = 'employer_nita_expense');

-- 4. FK on pack_account_roles.role_key → system_account_roles.role_key.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'pack_account_roles_role_key_fkey'
       AND conrelid = 'public.pack_account_roles'::regclass
  ) THEN
    ALTER TABLE public.pack_account_roles
      ADD CONSTRAINT pack_account_roles_role_key_fkey
      FOREIGN KEY (role_key) REFERENCES public.system_account_roles(role_key)
      ON UPDATE CASCADE ON DELETE RESTRICT NOT VALID;
    BEGIN
      ALTER TABLE public.pack_account_roles VALIDATE CONSTRAINT pack_account_roles_role_key_fkey;
    EXCEPTION WHEN foreign_key_violation THEN
      RAISE NOTICE 'pack_account_roles has unregistered role_key rows; FK remains NOT VALID until they are cleaned up.';
    END;
  END IF;
END $$;

-- 5. NITA remittance: switch from annual to monthly, 9th of next month.
UPDATE public.localization_pack_remittance_schedules
SET frequency = 'monthly',
    due_day   = 9,
    authority_name = 'National Industrial Training Authority (NITA)'
WHERE pack_id = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890'::uuid
  AND rule_code = 'nita';

-- 6. Mandatory diff-acknowledgement columns on pack_upgrade_proposals.
ALTER TABLE public.pack_upgrade_proposals
  ADD COLUMN IF NOT EXISTS acknowledged_diff_hash text,
  ADD COLUMN IF NOT EXISTS acknowledged_by uuid,
  ADD COLUMN IF NOT EXISTS acknowledged_at timestamptz,
  ADD COLUMN IF NOT EXISTS applied_version_id uuid REFERENCES public.pack_versions(id),
  ADD COLUMN IF NOT EXISTS applied_at timestamptz,
  ADD COLUMN IF NOT EXISTS reverted_at timestamptz,
  ADD COLUMN IF NOT EXISTS reverted_by uuid;

-- Allow 'reverted' in status CHECK if one is defined.
DO $$
DECLARE
  v_name text;
  v_def  text;
BEGIN
  SELECT c.conname, pg_get_constraintdef(c.oid) INTO v_name, v_def
    FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid
   WHERE t.relname = 'pack_upgrade_proposals'
     AND c.contype = 'c'
     AND pg_get_constraintdef(c.oid) ILIKE '%status%'
   LIMIT 1;
  IF v_name IS NOT NULL AND v_def NOT ILIKE '%reverted%' THEN
    EXECUTE format('ALTER TABLE public.pack_upgrade_proposals DROP CONSTRAINT %I', v_name);
    ALTER TABLE public.pack_upgrade_proposals
      ADD CONSTRAINT pack_upgrade_proposals_status_check
      CHECK (status IN ('pending','proposed','accepted','rejected','reverted'));
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.acknowledge_pack_upgrade_diff(_proposal_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_proposal RECORD;
  v_hash text;
  v_actor uuid := auth.uid();
  v_is_admin boolean;
  v_is_member boolean;
BEGIN
  SELECT * INTO v_proposal FROM public.pack_upgrade_proposals WHERE id = _proposal_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Proposal % not found', _proposal_id USING ERRCODE = 'no_data_found';
  END IF;

  v_is_admin := public.is_platform_admin(v_actor);
  IF NOT v_is_admin THEN
    SELECT EXISTS (
      SELECT 1 FROM public.user_business_access
      WHERE user_id = v_actor AND business_id = v_proposal.business_id
    ) INTO v_is_member;
    IF NOT v_is_member THEN
      RAISE EXCEPTION 'Not authorized to acknowledge upgrades for this business'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
  END IF;

  v_hash := md5(coalesce(v_proposal.diff::text, ''));
  UPDATE public.pack_upgrade_proposals
    SET acknowledged_diff_hash = v_hash,
        acknowledged_by = v_actor,
        acknowledged_at = now()
    WHERE id = _proposal_id;

  RETURN jsonb_build_object('proposal_id', _proposal_id, 'diff_hash', v_hash);
END;
$$;
GRANT EXECUTE ON FUNCTION public.acknowledge_pack_upgrade_diff(uuid) TO authenticated, service_role;

-- 7. Hoist the existing apply_pack_upgrade_atomic body into an "unchecked"
--    inner function, then wrap it with the diff-ack + version-pin layer.
CREATE OR REPLACE FUNCTION public._apply_pack_upgrade_atomic_unchecked(_proposal_id uuid)
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
  v_diff jsonb := jsonb_build_object('added','[]'::jsonb,'modified','[]'::jsonb,'removed','[]'::jsonb,'conflicts','[]'::jsonb);
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
  IF v_proposal.status NOT IN ('pending','proposed') THEN
    RAISE EXCEPTION 'Proposal % is in status % (must be pending/proposed)', _proposal_id, v_proposal.status;
  END IF;

  v_is_admin := public.is_platform_admin(v_actor);
  IF NOT v_is_admin THEN
    SELECT EXISTS (SELECT 1 FROM public.user_business_access
                   WHERE user_id = v_actor AND business_id = v_proposal.business_id) INTO v_is_member;
    IF NOT v_is_member THEN
      RAISE EXCEPTION 'Not authorized to apply upgrades for this business'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
  END IF;

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

  FOR v_incoming_rule IN
    SELECT jsonb_array_elements(COALESCE(v_to_snapshot->'payroll_rules','[]'::jsonb))
  LOOP
    v_rule_code := v_incoming_rule->>'rule_code';
    IF v_rule_code IS NULL THEN CONTINUE; END IF;

    SELECT * INTO v_existing FROM public.payroll_statutory_rules
      WHERE organization_id = v_proposal.organization_id
        AND (business_id = v_proposal.business_id OR (business_id IS NULL AND v_proposal.business_id IS NULL))
        AND rule_code = v_rule_code
      LIMIT 1;

    IF NOT FOUND THEN
      INSERT INTO public.payroll_statutory_rules
        (organization_id, business_id, country_code, rule_type, rule_name, rule_code,
         computation_method, parameters, effective_from, effective_to, sort_order,
         is_active, base_pack_template_id, base_pack_version)
      VALUES
        (v_proposal.organization_id, v_proposal.business_id,
         COALESCE(v_incoming_rule->>'country_code',''),
         COALESCE(v_incoming_rule->>'rule_type','statutory_deduction'),
         COALESCE(v_incoming_rule->>'rule_name', v_rule_code),
         v_rule_code,
         COALESCE(v_incoming_rule->>'computation_method','percentage_of_gross'),
         COALESCE(v_incoming_rule->'parameters','{}'::jsonb),
         COALESCE((v_incoming_rule->>'effective_from')::date, CURRENT_DATE),
         NULLIF(v_incoming_rule->>'effective_to','')::date,
         COALESCE((v_incoming_rule->>'sort_order')::int, 100),
         true,
         NULLIF(v_incoming_rule->>'template_id','')::uuid,
         v_proposal.to_version);
      v_added := v_added + 1;
      v_diff := jsonb_set(v_diff,'{added}',(v_diff->'added') || jsonb_build_array(v_rule_code));
    ELSIF COALESCE(v_existing.is_tenant_override,false) THEN
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
      v_diff := jsonb_set(v_diff,'{conflicts}',(v_diff->'conflicts') || jsonb_build_array(v_rule_code));
    ELSE
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
      v_diff := jsonb_set(v_diff,'{modified}',(v_diff->'modified') || jsonb_build_array(v_rule_code));
    END IF;
  END LOOP;

  FOR v_rule_code IN
    SELECT DISTINCT x->>'rule_code'
    FROM jsonb_array_elements(COALESCE(v_from_snapshot->'payroll_rules','[]'::jsonb)) AS x
    WHERE x->>'rule_code' IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM jsonb_array_elements(COALESCE(v_to_snapshot->'payroll_rules','[]'::jsonb)) AS y
        WHERE y->>'rule_code' = x->>'rule_code')
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
      v_diff := jsonb_set(v_diff,'{removed}',(v_diff->'removed') || jsonb_build_array(v_rule_code));
    END IF;
  END LOOP;

  UPDATE public.installed_localization_packs
    SET pack_version = v_proposal.to_version, installed_at = now(),
        installed_by = COALESCE(v_actor, installed_by)
    WHERE organization_id = v_proposal.organization_id
      AND (business_id = v_proposal.business_id OR (business_id IS NULL AND v_proposal.business_id IS NULL))
      AND pack_id = v_proposal.pack_id;

  UPDATE public.pack_upgrade_proposals
    SET status = 'accepted', decided_by = v_actor, decided_at = now()
    WHERE id = _proposal_id;

  INSERT INTO public.pack_migration_log
    (organization_id, business_id, pack_id, pack_version, scope, entity_table, entity_id,
     reason, before_value, after_value, applied_by)
  VALUES
    (v_proposal.organization_id, v_proposal.business_id, v_proposal.pack_id, v_proposal.to_version,
     'upgrade','pack_upgrade_proposals',_proposal_id,'apply_pack_upgrade_atomic',
     jsonb_build_object('from_version', v_proposal.from_version),
     jsonb_build_object('to_version', v_proposal.to_version,'added',v_added,'modified',v_modified,
                        'removed',v_removed,'conflicts',v_conflicts,'diff',v_diff),
     v_actor);

  RETURN jsonb_build_object('proposal_id',_proposal_id,'from_version',v_proposal.from_version,
    'to_version',v_proposal.to_version,'added',v_added,'modified',v_modified,
    'removed',v_removed,'conflicts',v_conflicts,'diff',v_diff);
END;
$$;
REVOKE ALL ON FUNCTION public._apply_pack_upgrade_atomic_unchecked(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public._apply_pack_upgrade_atomic_unchecked(uuid) TO service_role;

-- 7b. Replace apply_pack_upgrade_atomic with the gated wrapper.
CREATE OR REPLACE FUNCTION public.apply_pack_upgrade_atomic(_proposal_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_ack_hash text;
  v_diff_hash text;
  v_diff jsonb;
  v_result jsonb;
  v_to_version_id uuid;
  v_to_version text;
  v_pack_id uuid;
BEGIN
  SELECT acknowledged_diff_hash, diff, to_version, pack_id
    INTO v_ack_hash, v_diff, v_to_version, v_pack_id
    FROM public.pack_upgrade_proposals
    WHERE id = _proposal_id;

  IF v_ack_hash IS NULL THEN
    RAISE EXCEPTION 'Upgrade proposal % has not been acknowledged. Call acknowledge_pack_upgrade_diff() after the user has reviewed the diff.', _proposal_id
      USING ERRCODE = 'check_violation';
  END IF;

  v_diff_hash := md5(coalesce(v_diff::text, ''));
  IF v_ack_hash <> v_diff_hash THEN
    RAISE EXCEPTION 'Acknowledged diff hash does not match the current proposal diff. The diff changed since acknowledgement; please re-acknowledge.'
      USING ERRCODE = 'check_violation';
  END IF;

  v_result := public._apply_pack_upgrade_atomic_unchecked(_proposal_id);

  SELECT id INTO v_to_version_id FROM public.pack_versions
    WHERE pack_id = v_pack_id AND version = v_to_version
    ORDER BY published_at DESC NULLS LAST LIMIT 1;

  UPDATE public.pack_upgrade_proposals
    SET applied_version_id = v_to_version_id,
        applied_at         = now()
    WHERE id = _proposal_id;

  RETURN v_result;
END;
$$;
GRANT EXECUTE ON FUNCTION public.apply_pack_upgrade_atomic(uuid) TO authenticated, service_role;

-- 8. True rollback path.
CREATE OR REPLACE FUNCTION public.revert_pack_upgrade_atomic(_proposal_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_proposal RECORD;
  v_actor uuid := auth.uid();
  v_is_admin boolean;
  v_is_member boolean;
  v_count int;
  v_inverse_id uuid;
  v_result jsonb;
  v_diff jsonb;
BEGIN
  SELECT * INTO v_proposal FROM public.pack_upgrade_proposals WHERE id = _proposal_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Proposal % not found', _proposal_id USING ERRCODE = 'no_data_found';
  END IF;
  IF v_proposal.status <> 'accepted' OR v_proposal.applied_at IS NULL THEN
    RAISE EXCEPTION 'Proposal % is not in an accepted+applied state', _proposal_id
      USING ERRCODE = 'check_violation';
  END IF;
  IF v_proposal.reverted_at IS NOT NULL THEN
    RAISE EXCEPTION 'Proposal % was already reverted at %', _proposal_id, v_proposal.reverted_at
      USING ERRCODE = 'check_violation';
  END IF;

  v_is_admin := public.is_platform_admin(v_actor);
  IF NOT v_is_admin THEN
    SELECT EXISTS (SELECT 1 FROM public.user_business_access
                   WHERE user_id = v_actor AND business_id = v_proposal.business_id) INTO v_is_member;
    IF NOT v_is_member THEN
      RAISE EXCEPTION 'Not authorized to revert upgrades for this business'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
  END IF;

  SELECT count(*) INTO v_count
    FROM public.payroll_runs
    WHERE business_id = v_proposal.business_id
      AND pack_version_id = v_proposal.applied_version_id
      AND status IN ('completed','posted','paid','closed');
  IF v_count > 0 THEN
    RAISE EXCEPTION
      'Cannot revert: % payroll run(s) have been finalized against pack version % for this business. Reverse those runs first.',
      v_count, v_proposal.to_version
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT count(*) INTO v_count
    FROM public.payroll_runs
    WHERE business_id = v_proposal.business_id
      AND status IN ('draft','pending','processing','pending_approval');
  IF v_count > 0 THEN
    RAISE EXCEPTION
      'Cannot revert while % payroll run(s) are open. Close, post, or cancel them first.',
      v_count
      USING ERRCODE = 'check_violation';
  END IF;

  v_diff := jsonb_build_object(
    'kind','revert',
    'reverted_proposal_id', _proposal_id,
    'original_diff', v_proposal.diff);

  INSERT INTO public.pack_upgrade_proposals
    (organization_id, business_id, pack_id, from_version, to_version,
     diff, status, acknowledged_diff_hash, acknowledged_by, acknowledged_at)
  VALUES
    (v_proposal.organization_id, v_proposal.business_id, v_proposal.pack_id,
     v_proposal.to_version, v_proposal.from_version,
     v_diff, 'pending', md5(v_diff::text), v_actor, now())
  RETURNING id INTO v_inverse_id;

  v_result := public._apply_pack_upgrade_atomic_unchecked(v_inverse_id);

  UPDATE public.pack_upgrade_proposals
    SET reverted_at = now(), reverted_by = v_actor, status = 'reverted'
    WHERE id = _proposal_id;

  RETURN jsonb_build_object(
    'reverted_proposal_id', _proposal_id,
    'inverse_proposal_id',  v_inverse_id,
    'from_version',         v_proposal.to_version,
    'to_version',           v_proposal.from_version,
    'result',               v_result);
END;
$$;
GRANT EXECUTE ON FUNCTION public.revert_pack_upgrade_atomic(uuid) TO authenticated, service_role;
