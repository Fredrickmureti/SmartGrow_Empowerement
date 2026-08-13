-- 1. Register the governance action key
INSERT INTO public.governance_action_registry
  (action_key, label, description, module, severity_default, subject_mode, subject_table, requires_approval_always, is_active)
VALUES
  ('procurement_contract.activate',
   'Activate procurement contract',
   'Approve and activate a supplier framework / blanket agreement so purchase orders may consume it.',
   'Purchasing', 'high', 'actor', 'procurement_contracts', false, true)
ON CONFLICT (action_key) DO UPDATE
  SET is_active = true,
      label = EXCLUDED.label,
      description = EXCLUDED.description,
      module = EXCLUDED.module,
      severity_default = EXCLUDED.severity_default,
      subject_table = EXCLUDED.subject_table,
      updated_at = now();

-- 2. Submit: routing failures must surface, not be swallowed
CREATE OR REPLACE FUNCTION public.submit_procurement_contract(p_contract_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE v_c RECORD; v_uid uuid := auth.uid(); v_req uuid;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Not authenticated' USING ERRCODE='42501'; END IF;
  SELECT * INTO v_c FROM public.procurement_contracts WHERE id = p_contract_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('success', false, 'error', 'Contract not found'); END IF;
  IF NOT public.user_can_access_business(v_uid, v_c.business_id) THEN
    RETURN jsonb_build_object('success', false, 'error', 'Access denied'); END IF;
  IF v_c.status <> 'draft' THEN
    RETURN jsonb_build_object('success', false, 'error', 'Only draft contracts can be submitted'); END IF;
  IF NOT EXISTS (SELECT 1 FROM public.procurement_contract_lines WHERE contract_id = p_contract_id) THEN
    RETURN jsonb_build_object('success', false, 'error', 'Add at least one contract line before submitting'); END IF;

  -- Single governance engine (ADR-0101). A routing failure is a hard failure:
  -- silently proceeding would leave an unapproved contract in pending_approval
  -- with nothing able to decide it.
  v_req := (public.approval_route(
    'procurement_contract.activate', 'procurement_contract', p_contract_id,
    v_c.contract_number,
    jsonb_build_object('ceiling_value', v_c.ceiling_value, 'currency', v_c.currency,
                       'supplier_id', v_c.supplier_id),
    jsonb_build_object('business_id', v_c.business_id),
    'procurement_contract.activate:' || p_contract_id::text,
    v_c.business_id
  )->>'approval_request_id')::uuid;

  UPDATE public.procurement_contracts
     SET status = 'pending_approval', submitted_by = v_uid, submitted_at = now(),
         approval_request_id = v_req, updated_at = now()
   WHERE id = p_contract_id;

  PERFORM public._pc_emit(v_c.organization_id, p_contract_id, 'submitted',
    jsonb_build_object('approval_request_id', v_req));
  RETURN jsonb_build_object('success', true, 'approval_request_id', v_req,
                            'governed', v_req IS NOT NULL);
END
$fn$;

-- 3. Shared activation core, used by both the governance mirror and the fallback RPC
CREATE OR REPLACE FUNCTION public._pc_apply_activation(p_contract_id uuid, p_actor uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE v_c RECORD; v_rate numeric; v_base text;
BEGIN
  SELECT * INTO v_c FROM public.procurement_contracts WHERE id = p_contract_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('success', false, 'error', 'Contract not found'); END IF;
  IF v_c.end_date IS NOT NULL AND v_c.end_date < current_date THEN
    RETURN jsonb_build_object('success', false, 'error', 'Extend the end date before activating'); END IF;

  SELECT base_currency INTO v_base FROM public.businesses WHERE id = v_c.business_id;

  -- One FX engine (ADR-0136). No local lookup, no silent 1, no silent NULL.
  IF v_c.currency = v_base THEN
    v_rate := 1;
  ELSE
    v_rate := public.require_exchange_rate(v_c.organization_id, v_c.business_id,
                                           v_c.currency, current_date);
  END IF;

  UPDATE public.procurement_contracts
     SET status = 'active', approved_by = p_actor, approved_at = now(),
         base_currency = v_base, exchange_rate = v_rate, exchange_rate_date = current_date,
         updated_at = now()
   WHERE id = p_contract_id;

  PERFORM public._pc_emit(v_c.organization_id, p_contract_id, 'activated',
    jsonb_build_object('supplier_id', v_c.supplier_id, 'exchange_rate', v_rate), v_c.status::text);
  RETURN jsonb_build_object('success', true, 'exchange_rate', v_rate);
END
$fn$;

REVOKE ALL ON FUNCTION public._pc_apply_activation(uuid, uuid) FROM public, anon, authenticated;

-- 4. Fallback RPC: refuses while governance owns the decision
CREATE OR REPLACE FUNCTION public.activate_procurement_contract(p_contract_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE v_c RECORD; v_uid uuid := auth.uid();
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Not authenticated' USING ERRCODE='42501'; END IF;
  SELECT * INTO v_c FROM public.procurement_contracts WHERE id = p_contract_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('success', false, 'error', 'Contract not found'); END IF;
  IF NOT public.user_can_access_business(v_uid, v_c.business_id) THEN
    RETURN jsonb_build_object('success', false, 'error', 'Access denied'); END IF;
  IF NOT public.user_has_module_permission(v_uid, v_c.organization_id, v_c.business_id, 'purchases', 'write') THEN
    RETURN jsonb_build_object('success', false, 'error', 'Purchasing approval permission required'); END IF;
  IF v_c.status NOT IN ('pending_approval','suspended','expired') THEN
    RETURN jsonb_build_object('success', false, 'error', 'Contract must be submitted for approval first'); END IF;

  -- Governance owns this decision while a live request exists (ADR-0101).
  IF EXISTS (
    SELECT 1 FROM public.approval_requests r
     WHERE r.entity_type = 'procurement_contract'
       AND r.entity_id = p_contract_id
       AND r.status IN ('pending','in_progress','escalated')
  ) THEN
    RAISE EXCEPTION 'This contract has a live approval request; decide it in Approvals.'
      USING ERRCODE = '42501', HINT = 'GOV_USE_APPROVAL_ENGINE';
  END IF;

  -- Ungated fallback keeps the segregation-of-duties backstop.
  IF v_c.status = 'pending_approval' AND v_c.created_by = v_uid THEN
    RETURN jsonb_build_object('success', false, 'error', 'Segregation of duties: approver cannot be the creator');
  END IF;

  RETURN public._pc_apply_activation(p_contract_id, v_uid);
END
$fn$;

-- 5. Governance decision mirror
CREATE OR REPLACE FUNCTION public._mirror_approval_to_procurement_contract()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE v_c RECORD; v_actor uuid;
BEGIN
  IF NEW.entity_type <> 'procurement_contract' THEN RETURN NEW; END IF;
  IF TG_OP = 'UPDATE' AND NEW.status IS NOT DISTINCT FROM OLD.status THEN RETURN NEW; END IF;

  SELECT * INTO v_c FROM public.procurement_contracts WHERE id = NEW.entity_id;
  IF v_c.id IS NULL THEN RETURN NEW; END IF;
  IF v_c.status <> 'pending_approval' THEN RETURN NEW; END IF;

  SELECT h.actor_user_id INTO v_actor
    FROM public.approval_history h
   WHERE h.request_id = NEW.id AND h.actor_user_id IS NOT NULL
   ORDER BY h.created_at DESC
   LIMIT 1;
  v_actor := COALESCE(auth.uid(), v_actor);

  IF NEW.status = 'approved' THEN
    PERFORM public._pc_apply_activation(NEW.entity_id, v_actor);
  ELSIF NEW.status IN ('rejected','cancelled') THEN
    UPDATE public.procurement_contracts
       SET status = 'draft', submitted_by = NULL, submitted_at = NULL,
           approval_request_id = NULL, updated_at = now()
     WHERE id = NEW.entity_id;
    PERFORM public._pc_emit(v_c.organization_id, NEW.entity_id, 'rejected',
      jsonb_build_object('approval_request_id', NEW.id, 'status', NEW.status), 'pending_approval');
  END IF;

  RETURN NEW;
END
$fn$;

DROP TRIGGER IF EXISTS trg_mirror_approval_to_procurement_contract ON public.approval_requests;
CREATE TRIGGER trg_mirror_approval_to_procurement_contract
AFTER UPDATE ON public.approval_requests
FOR EACH ROW EXECUTE FUNCTION public._mirror_approval_to_procurement_contract();