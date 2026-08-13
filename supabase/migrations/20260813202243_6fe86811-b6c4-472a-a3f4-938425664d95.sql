
-- 1. Register the governed actions -------------------------------------------
INSERT INTO public.governance_action_registry
  (action_key, module, subject_table, subject_mode, label, description, severity_default, is_active)
VALUES
  ('landed_cost.post', 'purchases', 'landed_cost_vouchers', 'from_entity',
   'Post landed cost voucher',
   'Capitalises attributable acquisition costs into inventory value and posts the journal.',
   'high', true),
  ('landed_cost.reverse', 'purchases', 'landed_cost_vouchers', 'from_entity',
   'Reverse landed cost posting',
   'Reverses a posted landed cost voucher, its inventory revaluation and its journal.',
   'high', true)
ON CONFLICT (action_key) DO UPDATE
  SET module = EXCLUDED.module,
      subject_table = EXCLUDED.subject_table,
      label = EXCLUDED.label,
      description = EXCLUDED.description,
      is_active = true,
      updated_at = now();

-- 2. Move the posting body into an internal apply function --------------------
CREATE OR REPLACE FUNCTION public._landed_cost_post_apply(p_voucher_id uuid, p_actor uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v RECORD;
  v_actor uuid := p_actor;
  v_date date;
  v_inventory_acct uuid;
  v_cogs_acct uuid;
  v_clearing_acct uuid;
  v_target RECORD;
  v_res jsonb;
  v_cap_total numeric := 0;
  v_exp_total numeric := 0;
  v_noncap RECORD;
  v_lines jsonb := '[]'::jsonb;
  v_credit_total numeric := 0;
  v_je_id uuid;
BEGIN
  SELECT * INTO v FROM public.landed_cost_vouchers WHERE id = p_voucher_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'landed cost voucher % not found', p_voucher_id USING ERRCODE = 'P0002';
  END IF;

  -- Idempotency: a retried post of an already-posted voucher is a no-op.
  IF v.status = 'posted' THEN
    RETURN jsonb_build_object(
      'voucher_id', p_voucher_id, 'status', 'posted',
      'journal_entry_id', v.journal_entry_id,
      'capitalized_amount', v.capitalized_amount,
      'expensed_amount', v.expensed_amount,
      'already_posted', true);
  END IF;

  IF v.status NOT IN ('allocated', 'pending_approval') THEN
    RAISE EXCEPTION 'voucher % must be allocated before posting (currently %)', p_voucher_id, v.status
      USING ERRCODE = 'P0001';
  END IF;

  v_date := COALESCE(v.posting_date, v.voucher_date, CURRENT_DATE);

  IF public.is_period_locked(v.organization_id, v.business_id, v_date) THEN
    RAISE EXCEPTION 'accounting period for % is closed', v_date USING ERRCODE = 'P0001';
  END IF;

  v_inventory_acct := public.resolve_posting_account(v.business_id, 'inventory', v.branch_id);
  v_cogs_acct := public.resolve_posting_account(v.business_id, 'cogs', v.branch_id);
  v_clearing_acct := public.resolve_posting_account(v.business_id, 'landed_cost_clearing', v.branch_id);

  IF v_inventory_acct IS NULL THEN
    RAISE EXCEPTION 'no Inventory account configured for this business' USING ERRCODE = 'P0001';
  END IF;
  IF v_clearing_acct IS NULL THEN
    RAISE EXCEPTION 'no Landed Cost Clearing account configured — map the "landed_cost_clearing" role first'
      USING ERRCODE = 'P0001';
  END IF;

  FOR v_target IN
    SELECT a.goods_receipt_item_id AS gri_id,
           SUM(a.allocated_amount) AS amount
      FROM public.landed_cost_allocations a
      JOIN public.landed_cost_components c ON c.id = a.component_id
     WHERE a.voucher_id = p_voucher_id
       AND c.is_capitalizable IS TRUE
     GROUP BY a.goods_receipt_item_id
    HAVING SUM(a.allocated_amount) <> 0
  LOOP
    v_res := public.inventory_apply_cost_revaluation(
      v_target.gri_id, v_target.amount, 'landed_cost_voucher', p_voucher_id, v_actor);

    v_cap_total := v_cap_total + COALESCE((v_res->>'capitalized')::numeric, 0);
    v_exp_total := v_exp_total + COALESCE((v_res->>'expensed')::numeric, 0);

    UPDATE public.landed_cost_allocations a
       SET capitalized_amount = ROUND(a.allocated_amount
             * COALESCE((v_res->>'capitalized')::numeric, 0) / NULLIF(v_target.amount, 0), 2),
           expensed_amount = a.allocated_amount - ROUND(a.allocated_amount
             * COALESCE((v_res->>'capitalized')::numeric, 0) / NULLIF(v_target.amount, 0), 2),
           revaluation_result = v_res
     WHERE a.voucher_id = p_voucher_id
       AND a.goods_receipt_item_id = v_target.gri_id;
  END LOOP;

  IF v_exp_total <> 0 AND v_cogs_acct IS NULL THEN
    RAISE EXCEPTION
      'part of this landed cost belongs to stock already sold, but no Cost of Goods Sold account is configured'
      USING ERRCODE = 'P0001';
  END IF;

  IF v_cap_total <> 0 THEN
    v_lines := v_lines || jsonb_build_array(jsonb_build_object(
      'account_id', v_inventory_acct, 'debit', v_cap_total, 'credit', 0,
      'description', 'Landed cost capitalised to inventory — ' || COALESCE(v.voucher_number, '')));
  END IF;

  IF v_exp_total <> 0 THEN
    v_lines := v_lines || jsonb_build_array(jsonb_build_object(
      'account_id', v_cogs_acct, 'debit', v_exp_total, 'credit', 0,
      'description', 'Landed cost on stock already sold — ' || COALESCE(v.voucher_number, '')));
  END IF;

  v_credit_total := v_cap_total + v_exp_total;

  FOR v_noncap IN
    SELECT c.id, c.description, c.base_amount,
           COALESCE(c.expense_account_id, t.expense_account_id) AS account_id
      FROM public.landed_cost_components c
      LEFT JOIN public.landed_cost_component_types t ON t.id = c.component_type_id
     WHERE c.voucher_id = p_voucher_id
       AND c.is_capitalizable IS NOT TRUE
       AND c.base_amount <> 0
  LOOP
    IF v_noncap.account_id IS NULL THEN
      RAISE EXCEPTION 'non-capitalisable charge "%" has no expense account',
        COALESCE(v_noncap.description, v_noncap.id::text) USING ERRCODE = 'P0001';
    END IF;
    v_lines := v_lines || jsonb_build_array(jsonb_build_object(
      'account_id', v_noncap.account_id, 'debit', v_noncap.base_amount, 'credit', 0,
      'description', COALESCE(v_noncap.description, 'Landed cost charge')));
    v_credit_total := v_credit_total + v_noncap.base_amount;
  END LOOP;

  IF v_credit_total = 0 THEN
    RAISE EXCEPTION 'voucher % has nothing to post', p_voucher_id USING ERRCODE = 'P0001';
  END IF;

  v_lines := v_lines || jsonb_build_array(jsonb_build_object(
    'account_id', v_clearing_acct, 'debit', 0, 'credit', v_credit_total,
    'description', 'Landed cost clearing — ' || COALESCE(v.voucher_number, ''),
    'contact_id', v.vendor_id));

  v_je_id := public.post_journal_entry_atomic(
    v.organization_id, v.business_id,
    public.generate_next_je_number(v.organization_id, v.business_id),
    v_date,
    COALESCE(v.voucher_number, 'Landed cost'),
    'Landed cost voucher ' || COALESCE(v.voucher_number, p_voucher_id::text),
    'landed_cost_voucher', p_voucher_id, v_actor, false, false,
    v_lines, v.currency, v.exchange_rate, 'main', v.branch_id);

  UPDATE public.landed_cost_vouchers
     SET status = 'posted', posted_at = now(), posted_by = v_actor,
         posting_date = v_date, journal_entry_id = v_je_id,
         capitalized_amount = v_cap_total, expensed_amount = v_exp_total
   WHERE id = p_voucher_id;

  PERFORM public._emit_landed_cost_outbox(p_voucher_id, 'posted',
    jsonb_build_object(
      'business_id', v.business_id,
      'voucher_id', p_voucher_id,
      'voucher_number', v.voucher_number,
      'capitalized_amount', v_cap_total,
      'expensed_amount', v_exp_total,
      'journal_entry_id', v_je_id));

  RETURN jsonb_build_object(
    'voucher_id', p_voucher_id, 'status', 'posted',
    'journal_entry_id', v_je_id,
    'capitalized_amount', v_cap_total,
    'expensed_amount', v_exp_total);
END;
$fn$;

REVOKE ALL ON FUNCTION public._landed_cost_post_apply(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public._landed_cost_post_apply(uuid, uuid) TO service_role;

-- 3. Public entry point: governance gate in front of the apply function -------
CREATE OR REPLACE FUNCTION public.landed_cost_post_voucher(p_voucher_id uuid, p_actor uuid DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v RECORD;
  v_actor uuid := COALESCE(p_actor, auth.uid());
  v_req public.approval_requests;
  v_gated boolean;
BEGIN
  SELECT * INTO v FROM public.landed_cost_vouchers WHERE id = p_voucher_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'landed cost voucher % not found', p_voucher_id USING ERRCODE = 'P0002';
  END IF;

  IF v_actor IS NULL OR NOT public.user_has_business_access(v_actor, v.business_id) THEN
    RAISE EXCEPTION 'access denied' USING ERRCODE = '42501';
  END IF;

  IF v.status = 'posted' THEN
    RETURN jsonb_build_object(
      'voucher_id', p_voucher_id, 'status', 'posted',
      'journal_entry_id', v.journal_entry_id,
      'capitalized_amount', v.capitalized_amount,
      'expensed_amount', v.expensed_amount,
      'already_posted', true);
  END IF;

  IF v.status = 'pending_approval' THEN
    RAISE EXCEPTION
      'voucher % is awaiting approval — posting happens automatically once it is approved', p_voucher_id
      USING ERRCODE = 'P0001';
  END IF;

  IF v.status <> 'allocated' THEN
    RAISE EXCEPTION 'voucher % must be allocated before posting (currently %)', p_voucher_id, v.status
      USING ERRCODE = 'P0001';
  END IF;

  -- Canonical governance engine. Returns NULL when policy does not gate this action.
  v_req := public.approval_route(
    'landed_cost.post', 'landed_cost_voucher', p_voucher_id, v.voucher_number,
    jsonb_build_object(
      'amount', v.total_base_amount,
      'total_amount', v.total_base_amount,
      'document_amount', v.total_amount,
      'currency', v.currency,
      'vendor_id', v.vendor_id),
    jsonb_build_object('organization_id', v.organization_id, 'branch_id', v.branch_id),
    'landed_cost.post:' || p_voucher_id::text,
    v.business_id);

  v_gated := v_req.id IS NOT NULL AND v_req.status NOT IN ('approved', 'auto_approved');

  IF v_gated THEN
    UPDATE public.landed_cost_vouchers
       SET status = 'pending_approval', approval_request_id = v_req.id, updated_at = now()
     WHERE id = p_voucher_id;

    PERFORM public._emit_landed_cost_outbox(p_voucher_id, 'submitted',
      jsonb_build_object(
        'business_id', v.business_id,
        'voucher_id', p_voucher_id,
        'voucher_number', v.voucher_number,
        'approval_request_id', v_req.id));

    RETURN jsonb_build_object(
      'voucher_id', p_voucher_id,
      'status', 'pending_approval',
      'gated', true,
      'approval_request_id', v_req.id);
  END IF;

  IF v_req.id IS NOT NULL THEN
    UPDATE public.landed_cost_vouchers
       SET approval_request_id = v_req.id WHERE id = p_voucher_id;
  END IF;

  RETURN public._landed_cost_post_apply(p_voucher_id, v_actor);
END;
$fn$;

-- 4. Mirror approval decisions back onto the voucher --------------------------
CREATE OR REPLACE FUNCTION public._mirror_approval_to_landed_cost()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v public.landed_cost_vouchers;
  v_actor uuid;
BEGIN
  IF NEW.entity_type <> 'landed_cost_voucher' THEN RETURN NEW; END IF;
  IF TG_OP = 'UPDATE' AND NEW.status IS NOT DISTINCT FROM OLD.status THEN RETURN NEW; END IF;

  SELECT * INTO v FROM public.landed_cost_vouchers WHERE id = NEW.entity_id;
  IF v.id IS NULL OR v.status <> 'pending_approval' THEN RETURN NEW; END IF;

  SELECT h.actor_user_id INTO v_actor
    FROM public.approval_history h
   WHERE h.request_id = NEW.id AND h.actor_user_id IS NOT NULL
   ORDER BY h.created_at DESC LIMIT 1;
  v_actor := COALESCE(auth.uid(), v_actor, v.created_by);

  IF NEW.status IN ('approved', 'auto_approved') THEN
    PERFORM public.governance_assert_not_self(
      v_actor, v.created_by, 'landed_cost.post',
      v.organization_id, 'landed_cost_voucher', v.id);

    PERFORM public._landed_cost_post_apply(v.id, v_actor);

  ELSIF NEW.status IN ('rejected', 'cancelled') THEN
    UPDATE public.landed_cost_vouchers
       SET status = 'allocated',
           approval_request_id = NULL,
           updated_at = now()
     WHERE id = v.id;

    PERFORM public._emit_landed_cost_outbox(v.id, 'approval_rejected',
      jsonb_build_object(
        'business_id', v.business_id,
        'voucher_id', v.id,
        'voucher_number', v.voucher_number,
        'approval_request_id', NEW.id,
        'decision', NEW.status));
  END IF;

  RETURN NEW;
END;
$fn$;

DROP TRIGGER IF EXISTS trg_mirror_approval_to_landed_cost ON public.approval_requests;
CREATE TRIGGER trg_mirror_approval_to_landed_cost
AFTER INSERT OR UPDATE ON public.approval_requests
FOR EACH ROW EXECUTE FUNCTION public._mirror_approval_to_landed_cost();

-- 5. Separation of duties on the voucher itself -------------------------------
CREATE OR REPLACE FUNCTION public.guard_landed_cost_self_approval()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
BEGIN
  IF NEW.status = 'posted' AND COALESCE(OLD.status::text, '') <> 'posted'
     AND NEW.posted_by IS NOT NULL AND NEW.created_by IS NOT NULL THEN
    PERFORM public.governance_assert_not_self(
      NEW.posted_by, NEW.created_by, 'landed_cost.post',
      NEW.organization_id, 'landed_cost_voucher', NEW.id);
  END IF;
  RETURN NEW;
END;
$fn$;

DROP TRIGGER IF EXISTS trg_landed_cost_self_approval ON public.landed_cost_vouchers;
CREATE TRIGGER trg_landed_cost_self_approval
BEFORE UPDATE ON public.landed_cost_vouchers
FOR EACH ROW EXECUTE FUNCTION public.guard_landed_cost_self_approval();
