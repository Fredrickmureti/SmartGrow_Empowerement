
-- =============================================================
-- M9 + M10 — extend pack upgrade propagation; publisher token self-serve
-- =============================================================

-- ---- M10: pack_token_registry publisher policy ----
DROP POLICY IF EXISTS "Pack publishers manage their pack tokens" ON public.pack_token_registry;
CREATE POLICY "Pack publishers manage their pack tokens" ON public.pack_token_registry
  FOR ALL TO authenticated
  USING (pack_id IS NOT NULL AND public.is_pack_publisher(auth.uid(), pack_id))
  WITH CHECK (pack_id IS NOT NULL AND public.is_pack_publisher(auth.uid(), pack_id));

-- ---- M9: extend _apply_pack_upgrade_atomic_unchecked ----
-- Add ADD-only propagation for tax_rates and accounts. Tenant
-- modifications/removals are never auto-clobbered (Odoo l10n posture):
-- new pack rows that the tenant does not yet have get inserted, anything
-- else is left to a manual reconciliation surface.
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
  v_diff jsonb := jsonb_build_object(
    'added','[]'::jsonb,'modified','[]'::jsonb,'removed','[]'::jsonb,'conflicts','[]'::jsonb,
    'tax_added','[]'::jsonb,'accounts_added','[]'::jsonb);
  v_added int := 0;
  v_modified int := 0;
  v_removed int := 0;
  v_conflicts int := 0;
  v_tax_added int := 0;
  v_accounts_added int := 0;
  v_incoming_rule jsonb;
  v_incoming jsonb;
  v_existing RECORD;
  v_rule_code text;
  v_key text;
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

  -- payroll_statutory_rules: full diff (add/modify/remove/conflict)
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

  -- ADD-only propagation: tax_rates
  FOR v_incoming IN
    SELECT jsonb_array_elements(COALESCE(v_to_snapshot->'localization_pack_tax_templates','[]'::jsonb))
  LOOP
    v_key := v_incoming->>'name';
    IF v_key IS NULL OR v_key = '' THEN CONTINUE; END IF;
    IF EXISTS (
      SELECT 1 FROM public.tax_rates
      WHERE organization_id = v_proposal.organization_id
        AND business_id = v_proposal.business_id
        AND name = v_key
    ) THEN CONTINUE; END IF;

    INSERT INTO public.tax_rates
      (organization_id, business_id, name, rate, description,
       is_compound, is_inclusive, is_default, is_active,
       tax_type, fixed_amount, effective_from)
    VALUES
      (v_proposal.organization_id, v_proposal.business_id,
       v_key,
       COALESCE((v_incoming->>'rate')::numeric, 0),
       v_incoming->>'description',
       COALESCE((v_incoming->>'is_compound')::boolean, false),
       COALESCE((v_incoming->>'is_inclusive')::boolean, false),
       COALESCE((v_incoming->>'is_default')::boolean, false),
       true,
       COALESCE(NULLIF(v_incoming->>'tax_type',''),'percentage'),
       0,
       CURRENT_DATE);
    v_tax_added := v_tax_added + 1;
    v_diff := jsonb_set(v_diff,'{tax_added}',(v_diff->'tax_added') || jsonb_build_array(v_key));
  END LOOP;

  -- ADD-only propagation: accounts
  FOR v_incoming IN
    SELECT jsonb_array_elements(COALESCE(v_to_snapshot->'localization_pack_account_templates','[]'::jsonb))
  LOOP
    v_key := v_incoming->>'code';
    IF v_key IS NULL OR v_key = '' THEN CONTINUE; END IF;
    IF EXISTS (
      SELECT 1 FROM public.accounts
      WHERE organization_id = v_proposal.organization_id
        AND business_id = v_proposal.business_id
        AND code = v_key
    ) THEN CONTINUE; END IF;

    INSERT INTO public.accounts
      (organization_id, business_id, code, name, account_type,
       description, cash_flow_category, is_system, is_active,
       opening_balance, current_balance)
    VALUES
      (v_proposal.organization_id, v_proposal.business_id,
       v_key,
       COALESCE(v_incoming->>'name', v_key),
       (CASE WHEN v_incoming->>'account_type' = 'revenue'
             THEN 'income' ELSE v_incoming->>'account_type' END)::account_type,
       v_incoming->>'description',
       v_incoming->>'cash_flow_category',
       COALESCE((v_incoming->>'is_system')::boolean, false),
       true, 0, 0);
    v_accounts_added := v_accounts_added + 1;
    v_diff := jsonb_set(v_diff,'{accounts_added}',(v_diff->'accounts_added') || jsonb_build_array(v_key));
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
                        'removed',v_removed,'conflicts',v_conflicts,
                        'tax_added',v_tax_added,'accounts_added',v_accounts_added,'diff',v_diff),
     v_actor);

  RETURN jsonb_build_object('proposal_id',_proposal_id,'from_version',v_proposal.from_version,
    'to_version',v_proposal.to_version,'added',v_added,'modified',v_modified,
    'removed',v_removed,'conflicts',v_conflicts,
    'tax_added',v_tax_added,'accounts_added',v_accounts_added,'diff',v_diff);
END;
$$;
REVOKE ALL ON FUNCTION public._apply_pack_upgrade_atomic_unchecked(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public._apply_pack_upgrade_atomic_unchecked(uuid) TO service_role;
