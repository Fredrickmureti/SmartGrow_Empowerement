
-- Step B remainder: auto-seed a default approval workflow for legal orders
-- when a tenant installs the legal-order kind defaults AND its self-action
-- policy for payroll.legal_order.activate requires approval.
-- Backward compatible: no-op when a workflow for entity_type='legal_order'
-- already exists in the org, or when self-action policy is 'allow' / 'block'.

CREATE OR REPLACE FUNCTION public.ensure_default_legal_order_workflow(
  p_organization_id uuid
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_policy_mode text;
  v_existing uuid;
  v_wf_id uuid;
BEGIN
  IF p_organization_id IS NULL THEN
    RETURN NULL;
  END IF;

  -- Only seed when policy explicitly says approval is required.
  SELECT mode INTO v_policy_mode
    FROM public.self_action_policy
    WHERE organization_id = p_organization_id
      AND action_key = 'payroll.legal_order.activate'
    LIMIT 1;

  IF COALESCE(v_policy_mode, '') <> 'require_approval' THEN
    RETURN NULL;
  END IF;

  -- Idempotent: bail if any legal_order workflow already exists.
  SELECT id INTO v_existing
    FROM public.approval_workflows
    WHERE organization_id = p_organization_id
      AND entity_type = 'legal_order'
    LIMIT 1;
  IF v_existing IS NOT NULL THEN
    RETURN v_existing;
  END IF;

  INSERT INTO public.approval_workflows (
    organization_id, name, entity_type, description, is_active, conditions
  ) VALUES (
    p_organization_id,
    'Legal Order Activation',
    'legal_order',
    'Default workflow seeded at pack install: legal orders must be approved by an admin or owner (SoD: not the submitter) before activation.',
    true,
    '{"actions": ["activate", "release", "terminate_unsatisfied"]}'::jsonb
  )
  RETURNING id INTO v_wf_id;

  INSERT INTO public.approval_workflow_steps (workflow_id, step_order, role, is_required)
  VALUES (v_wf_id, 1, 'admin', true);

  RETURN v_wf_id;
END $$;

REVOKE ALL ON FUNCTION public.ensure_default_legal_order_workflow(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.ensure_default_legal_order_workflow(uuid) TO service_role;

COMMENT ON FUNCTION public.ensure_default_legal_order_workflow IS
  'Step B (2026-07-23): idempotently seed a default legal_order approval workflow when self_action_policy requires approval.';

-- Hook into pack-install: call the helper at the end of the existing
-- install_legal_order_kind_defaults RPC so a fresh tenant lands with the
-- workflow already in place. Preserves the existing return contract
-- (row count of kind defaults inserted/updated).
CREATE OR REPLACE FUNCTION public.install_legal_order_kind_defaults(
  p_organization_id uuid,
  p_pack_id uuid
) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_count integer;
BEGIN
  IF p_organization_id IS NULL OR p_pack_id IS NULL THEN
    RAISE EXCEPTION 'install_legal_order_kind_defaults: organization_id and pack_id are required'
      USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.garnishment_kind_defaults (
    kind, default_priority, always_first, counts_toward_aggregate_cap,
    description, organization_id, source_pack_id, max_concurrent,
    employer_fee_amount, required_identifiers, evidence_required,
    calc_model, priority_class, protected_earnings_rule,
    aggregate_cap_membership, remittance_schedule_ref, evidence_requirements,
    completion_rule, reporting_binding_ref
  )
  SELECT
    k.code, k.default_priority, k.always_first, k.counts_toward_aggregate_cap,
    k.description, p_organization_id, p_pack_id, k.max_concurrent,
    k.employer_fee_amount, k.required_identifiers, k.evidence_required,
    COALESCE(k.calc_model, 'fixed'::public.legal_order_calc_model),
    k.priority_class,
    COALESCE(k.protected_earnings_rule, '{}'::jsonb),
    COALESCE(k.aggregate_cap_membership, CASE
      WHEN k.always_first THEN 'always_first'::public.legal_order_cap_membership
      WHEN NOT k.counts_toward_aggregate_cap THEN 'exempt'::public.legal_order_cap_membership
      ELSE 'in_pool'::public.legal_order_cap_membership
    END),
    k.remittance_schedule_ref,
    COALESCE(k.evidence_requirements, '{}'::jsonb),
    COALESCE(k.completion_rule, 'by_balance'::public.legal_order_completion_rule),
    k.reporting_binding_ref
  FROM public.localization_pack_garnishment_kinds k
  WHERE k.pack_id = p_pack_id
    AND k.is_active
  ON CONFLICT (organization_id, kind) DO UPDATE
    SET default_priority             = EXCLUDED.default_priority,
        always_first                 = EXCLUDED.always_first,
        counts_toward_aggregate_cap  = EXCLUDED.counts_toward_aggregate_cap,
        description                  = EXCLUDED.description,
        source_pack_id               = EXCLUDED.source_pack_id,
        max_concurrent               = EXCLUDED.max_concurrent,
        employer_fee_amount          = EXCLUDED.employer_fee_amount,
        required_identifiers         = EXCLUDED.required_identifiers,
        evidence_required            = EXCLUDED.evidence_required,
        calc_model                   = EXCLUDED.calc_model,
        priority_class               = EXCLUDED.priority_class,
        protected_earnings_rule      = EXCLUDED.protected_earnings_rule,
        aggregate_cap_membership     = EXCLUDED.aggregate_cap_membership,
        remittance_schedule_ref      = EXCLUDED.remittance_schedule_ref,
        evidence_requirements        = EXCLUDED.evidence_requirements,
        completion_rule              = EXCLUDED.completion_rule,
        reporting_binding_ref        = EXCLUDED.reporting_binding_ref;

  GET DIAGNOSTICS v_count = ROW_COUNT;

  -- Step B (2026-07-23): seed the default legal_order approval workflow when
  -- policy requires approval. Non-fatal: swallow errors so a permissions
  -- edge case cannot break pack install.
  BEGIN
    PERFORM public.ensure_default_legal_order_workflow(p_organization_id);
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'ensure_default_legal_order_workflow(%) failed: %', p_organization_id, SQLERRM;
  END;

  RETURN v_count;
END $$;
