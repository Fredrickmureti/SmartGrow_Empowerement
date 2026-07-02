-- =====================================================================
-- Wave 2 — Reason-aware GL + reversal + backfill (D1 + D2 + G10)
-- =====================================================================

-- D2a. Reversal columns
ALTER TABLE public.stock_adjustments
  ADD COLUMN IF NOT EXISTS reverses_adjustment_id uuid
    REFERENCES public.stock_adjustments(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS reversed_by_adjustment_id uuid
    REFERENCES public.stock_adjustments(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS reversal_reason text;

COMMENT ON COLUMN public.stock_adjustments.reverses_adjustment_id IS
  'When this row is a reversal, points at the original approved adjustment it reverses. Set by reverse_stock_adjustment_atomic.';
COMMENT ON COLUMN public.stock_adjustments.reversed_by_adjustment_id IS
  'When this row has been reversed, points at the mirror adjustment that reverses it. Set by reverse_stock_adjustment_atomic.';

-- D1a. Extend ensure_inventory_gl_accounts to provision reason-keyed accounts.
CREATE OR REPLACE FUNCTION public.ensure_inventory_reason_gl_accounts(
  _org_id uuid,
  _business_id uuid
) RETURNS TABLE(
  shrinkage_account_id uuid,
  overage_account_id   uuid,
  revaluation_account_id uuid
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_shrink uuid;
  v_over   uuid;
  v_reval  uuid;
  v_legacy_adj uuid;
  v_code text;
  v_clash int;
BEGIN
  IF _org_id IS NULL OR _business_id IS NULL THEN
    RAISE EXCEPTION 'ensure_inventory_reason_gl_accounts requires org and business ids';
  END IF;

  -- Legacy single-bucket fallback (used as default when reason-specific
  -- accounts haven't been set).
  SELECT adjustment_account_id INTO v_legacy_adj
    FROM public.ensure_inventory_gl_accounts(_org_id, _business_id);

  -- 1. Shrinkage / damage / write-off expense
  SELECT account_id INTO v_shrink
    FROM public.default_account_settings
   WHERE organization_id=_org_id AND business_id=_business_id
     AND setting_key='inventory_shrinkage_expense'
   LIMIT 1;
  IF v_shrink IS NULL THEN
    -- Fall back to legacy adjustment account so behaviour is unchanged
    -- for customers who never customised reason-specific accounts.
    v_shrink := v_legacy_adj;
    INSERT INTO public.default_account_settings (organization_id, business_id, branch_id, setting_key, account_id)
    VALUES (_org_id, _business_id, NULL, 'inventory_shrinkage_expense', v_shrink)
    ON CONFLICT (organization_id, business_id, branch_id, setting_key)
    DO NOTHING;
  END IF;

  -- 2. Overage / found-stock income
  SELECT account_id INTO v_over
    FROM public.default_account_settings
   WHERE organization_id=_org_id AND business_id=_business_id
     AND setting_key='inventory_overage_income'
   LIMIT 1;
  IF v_over IS NULL THEN
    SELECT id INTO v_over FROM public.accounts
     WHERE organization_id=_org_id AND business_id=_business_id
       AND detail_type IN ('other_income','other_business_income')
       AND coalesce(is_header,false)=false AND is_active=true
       AND (name ILIKE '%inventory%over%' OR name ILIKE '%found%stock%' OR name ILIKE '%inventory%gain%')
     ORDER BY code LIMIT 1;
    IF v_over IS NULL THEN
      SELECT id INTO v_over FROM public.accounts
       WHERE organization_id=_org_id AND business_id=_business_id
         AND detail_type IN ('other_income','other_business_income')
         AND coalesce(is_header,false)=false AND is_active=true
       ORDER BY code LIMIT 1;
    END IF;
    IF v_over IS NULL THEN
      v_code := '4910';
      SELECT count(*) INTO v_clash FROM public.accounts
       WHERE organization_id=_org_id AND business_id=_business_id AND code=v_code;
      IF v_clash > 0 THEN v_code := '4910-SYS'; END IF;
      INSERT INTO public.accounts (organization_id, business_id, account_type, detail_type, code, name, description, is_system, is_active, opening_balance, current_balance)
      VALUES (_org_id, _business_id, 'income', 'other_business_income', v_code, 'Inventory Overage / Found Stock', 'System inventory overage / found-stock income (auto-provisioned)', true, true, 0, 0)
      RETURNING id INTO v_over;
    END IF;
    INSERT INTO public.default_account_settings (organization_id, business_id, branch_id, setting_key, account_id)
    VALUES (_org_id, _business_id, NULL, 'inventory_overage_income', v_over)
    ON CONFLICT (organization_id, business_id, branch_id, setting_key)
    DO NOTHING;
  END IF;

  -- 3. Revaluation (P&L)
  SELECT account_id INTO v_reval
    FROM public.default_account_settings
   WHERE organization_id=_org_id AND business_id=_business_id
     AND setting_key='inventory_revaluation'
   LIMIT 1;
  IF v_reval IS NULL THEN
    v_reval := v_legacy_adj;
    INSERT INTO public.default_account_settings (organization_id, business_id, branch_id, setting_key, account_id)
    VALUES (_org_id, _business_id, NULL, 'inventory_revaluation', v_reval)
    ON CONFLICT (organization_id, business_id, branch_id, setting_key)
    DO NOTHING;
  END IF;

  shrinkage_account_id   := v_shrink;
  overage_account_id     := v_over;
  revaluation_account_id := v_reval;
  RETURN NEXT;
END;
$$;

GRANT EXECUTE ON FUNCTION public.ensure_inventory_reason_gl_accounts(uuid, uuid) TO authenticated, service_role;

-- D1b. Per-reason offset account resolver.
CREATE OR REPLACE FUNCTION public.resolve_adjustment_offset_account(
  p_org_id uuid,
  p_business_id uuid,
  p_reason text,
  p_sign int   -- +1 for increase, -1 for decrease
) RETURNS uuid
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_shrink uuid;
  v_over   uuid;
  v_reval  uuid;
  v_legacy uuid;
BEGIN
  SELECT shrinkage_account_id, overage_account_id, revaluation_account_id
    INTO v_shrink, v_over, v_reval
    FROM public.ensure_inventory_reason_gl_accounts(p_org_id, p_business_id);

  SELECT adjustment_account_id INTO v_legacy
    FROM public.ensure_inventory_gl_accounts(p_org_id, p_business_id);

  RETURN CASE lower(COALESCE(p_reason, ''))
    WHEN 'shrinkage'     THEN v_shrink
    WHEN 'damage'        THEN v_shrink
    WHEN 'write_off'     THEN v_shrink
    WHEN 'found_stock'   THEN v_over
    WHEN 'revaluation'   THEN v_reval
    WHEN 'count_variance' THEN CASE WHEN p_sign >= 0 THEN v_over ELSE v_shrink END
    WHEN 'opening_balance' THEN v_legacy
    ELSE v_legacy
  END;
END;
$$;

GRANT EXECUTE ON FUNCTION public.resolve_adjustment_offset_account(uuid, uuid, text, int) TO authenticated, service_role;

-- D1c. Rewrite approval RPC to group lines by reason-keyed offset account
-- and emit one balanced JE.
CREATE OR REPLACE FUNCTION public.approve_stock_adjustment_atomic(p_adjustment_id uuid, p_user_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_adjustment RECORD;
  v_item RECORD;
  v_org_id UUID;
  v_biz_id UUID;
  v_branch_id UUID;
  v_inventory_account_id UUID;
  v_adjustment_account_id UUID;
  v_offset_account UUID;
  v_reason text;
  v_journal_id UUID;
  v_resolved_cost numeric;
  v_cost_value numeric;
  v_lines jsonb := '[]'::jsonb;
  v_total_value numeric := 0;
  v_locked_qty numeric;
  v_inv_debit  numeric := 0;
  v_inv_credit numeric := 0;
  v_offset_rec RECORD;
BEGIN
  SELECT id, organization_id, business_id, branch_id, status, reason
    INTO v_adjustment
    FROM stock_adjustments
   WHERE id = p_adjustment_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'Adjustment not found');
  END IF;

  IF v_adjustment.status = 'approved' THEN
    RETURN jsonb_build_object('success', false, 'error',
      'Adjustment is already approved');
  END IF;

  IF v_adjustment.status NOT IN ('draft', 'pending_approval') THEN
    RETURN jsonb_build_object('success', false, 'error',
      'Adjustment cannot be approved (current status: ' || v_adjustment.status || ')');
  END IF;

  v_org_id    := v_adjustment.organization_id;
  v_biz_id    := v_adjustment.business_id;
  v_branch_id := v_adjustment.branch_id;
  v_reason    := v_adjustment.reason;

  IF v_biz_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error',
      'Adjustment has no business_id; cannot post to GL');
  END IF;

  -- Pre-flight: provision GL accounts (legacy + reason-keyed).
  SELECT inventory_account_id, adjustment_account_id
    INTO v_inventory_account_id, v_adjustment_account_id
    FROM public.ensure_inventory_gl_accounts(v_org_id, v_biz_id);

  IF v_inventory_account_id IS NULL OR v_adjustment_account_id IS NULL THEN
    RAISE EXCEPTION 'Cannot approve stock adjustment: inventory or adjustment GL account not provisioned for company %', v_biz_id;
  END IF;

  -- Pre-warm reason-keyed accounts so we fail fast if the chart is broken.
  PERFORM public.ensure_inventory_reason_gl_accounts(v_org_id, v_biz_id);

  -- Build a temp accumulator of (offset_account_id, inventory_delta, offset_delta).
  -- inventory side: debit on increase, credit on decrease.
  -- offset side  : credit on increase, debit on decrease.
  CREATE TEMP TABLE IF NOT EXISTS _adj_offset_acc (
    offset_account_id uuid PRIMARY KEY,
    inv_debit  numeric NOT NULL DEFAULT 0,
    inv_credit numeric NOT NULL DEFAULT 0,
    off_debit  numeric NOT NULL DEFAULT 0,
    off_credit numeric NOT NULL DEFAULT 0
  ) ON COMMIT DROP;
  DELETE FROM _adj_offset_acc;

  FOR v_item IN
    SELECT * FROM stock_adjustment_items WHERE adjustment_id = p_adjustment_id
  LOOP
    SELECT quantity INTO v_locked_qty
      FROM public.warehouse_stock
     WHERE product_id = v_item.product_id
       AND warehouse_id = v_item.warehouse_id
     FOR UPDATE;

    IF v_item.quantity_adjustment = 0 THEN
      v_resolved_cost := 0;
    ELSE
      v_resolved_cost := public.resolve_adjustment_unit_cost(
        v_org_id, v_biz_id, v_item.product_id, v_item.warehouse_id, v_item.unit_cost
      );
      IF v_resolved_cost IS NULL OR v_resolved_cost <= 0 THEN
        RAISE EXCEPTION 'Cannot approve stock adjustment: no valuation cost is available for product %. Provide a unit cost on the adjustment line, or set the product cost first.', v_item.product_id;
      END IF;

      IF v_item.unit_cost IS DISTINCT FROM v_resolved_cost THEN
        UPDATE public.stock_adjustment_items
           SET unit_cost = v_resolved_cost
         WHERE id = v_item.id;
      END IF;
    END IF;

    INSERT INTO stock_movements (
      organization_id, business_id, product_id, movement_type,
      quantity, unit_cost, warehouse_id,
      reference_type, reference_id, notes, created_by
    ) VALUES (
      v_org_id, v_biz_id, v_item.product_id, 'adjustment',
      v_item.quantity_adjustment, v_resolved_cost, v_item.warehouse_id,
      'stock_adjustment', p_adjustment_id, v_item.notes, p_user_id
    );

    v_cost_value := ABS(v_item.quantity_adjustment) * COALESCE(v_resolved_cost, 0);
    IF v_cost_value > 0 THEN
      v_offset_account := public.resolve_adjustment_offset_account(
        v_org_id, v_biz_id, v_reason, CASE WHEN v_item.quantity_adjustment > 0 THEN 1 ELSE -1 END
      );

      INSERT INTO _adj_offset_acc (offset_account_id, inv_debit, inv_credit, off_debit, off_credit)
      VALUES (
        v_offset_account,
        CASE WHEN v_item.quantity_adjustment > 0 THEN v_cost_value ELSE 0 END,
        CASE WHEN v_item.quantity_adjustment < 0 THEN v_cost_value ELSE 0 END,
        CASE WHEN v_item.quantity_adjustment < 0 THEN v_cost_value ELSE 0 END,
        CASE WHEN v_item.quantity_adjustment > 0 THEN v_cost_value ELSE 0 END
      )
      ON CONFLICT (offset_account_id) DO UPDATE SET
        inv_debit  = _adj_offset_acc.inv_debit  + EXCLUDED.inv_debit,
        inv_credit = _adj_offset_acc.inv_credit + EXCLUDED.inv_credit,
        off_debit  = _adj_offset_acc.off_debit  + EXCLUDED.off_debit,
        off_credit = _adj_offset_acc.off_credit + EXCLUDED.off_credit;

      v_total_value := v_total_value + v_cost_value;
    END IF;
  END LOOP;

  UPDATE stock_adjustments
     SET status = 'approved',
         approved_by = p_user_id,
         approved_at = now()
   WHERE id = p_adjustment_id;

  UPDATE approval_rule_logs
     SET status = 'approved',
         approved_by = p_user_id,
         approved_at = now()
   WHERE entity_type = 'stock_adjustment'
     AND entity_id = p_adjustment_id::text
     AND action_name = 'apply'
     AND status = 'pending';

  -- Build JE lines: per offset account, emit balanced inventory <-> offset pair(s).
  FOR v_offset_rec IN SELECT * FROM _adj_offset_acc LOOP
    IF v_offset_rec.inv_debit > 0 THEN
      v_lines := v_lines || jsonb_build_array(
        jsonb_build_object('account_id', v_inventory_account_id, 'debit', v_offset_rec.inv_debit, 'credit', 0,
                           'description', 'Stock Adjustment - Inventory Increase'),
        jsonb_build_object('account_id', v_offset_rec.offset_account_id, 'debit', 0, 'credit', v_offset_rec.off_credit,
                           'description', 'Stock Adjustment - Increase Offset')
      );
    END IF;
    IF v_offset_rec.inv_credit > 0 THEN
      v_lines := v_lines || jsonb_build_array(
        jsonb_build_object('account_id', v_offset_rec.offset_account_id, 'debit', v_offset_rec.off_debit, 'credit', 0,
                           'description', 'Stock Adjustment - Decrease Offset'),
        jsonb_build_object('account_id', v_inventory_account_id, 'debit', 0, 'credit', v_offset_rec.inv_credit,
                           'description', 'Stock Adjustment - Inventory Decrease')
      );
    END IF;
  END LOOP;

  IF jsonb_array_length(v_lines) > 0 THEN
    v_journal_id := public.post_journal_entry_atomic(
      _org_id          := v_org_id,
      _business_id     := v_biz_id,
      _entry_number    := public.get_next_journal_entry_number(v_org_id),
      _entry_date      := CURRENT_DATE,
      _reference       := 'ADJ-' || LEFT(p_adjustment_id::text, 8),
      _description     := 'Stock adjustment approved (' || COALESCE(v_reason, 'unspecified') || ')',
      _source_type     := 'stock_adjustment',
      _source_id       := p_adjustment_id,
      _created_by      := p_user_id,
      _is_closing      := false,
      _is_adjusting    := false,
      _lines           := v_lines,
      _branch_id       := v_branch_id
    );
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'adjustment_id', p_adjustment_id,
    'status', 'approved',
    'gl_posted', v_journal_id IS NOT NULL,
    'journal_entry_id', v_journal_id,
    'total_value', v_total_value
  );
END;
$function$;

-- D2b. Reversal RPC ----------------------------------------------------
CREATE OR REPLACE FUNCTION public.reverse_stock_adjustment_atomic(
  p_adjustment_id uuid,
  p_user_id uuid,
  p_reversal_reason text DEFAULT NULL,
  p_client_request_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_orig RECORD;
  v_item RECORD;
  v_new_id uuid;
  v_new_number text;
  v_before numeric;
  v_apply jsonb;
  v_lock_exists boolean;
BEGIN
  SELECT * INTO v_orig
    FROM public.stock_adjustments
   WHERE id = p_adjustment_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Adjustment % not found', p_adjustment_id;
  END IF;
  IF v_orig.status <> 'approved' THEN
    RAISE EXCEPTION 'Only approved adjustments can be reversed (current status: %)', v_orig.status;
  END IF;
  IF v_orig.reversed_by_adjustment_id IS NOT NULL THEN
    RAISE EXCEPTION 'Adjustment % is already reversed by %', p_adjustment_id, v_orig.reversed_by_adjustment_id;
  END IF;
  IF v_orig.reverses_adjustment_id IS NOT NULL THEN
    RAISE EXCEPTION 'Adjustment % is itself a reversal and cannot be reversed', p_adjustment_id;
  END IF;

  -- Period-lock guard: if a lock_dates row covers today's date for this
  -- (org, business), refuse to post the reversal.
  SELECT EXISTS (
    SELECT 1 FROM public.lock_dates ld
     WHERE ld.organization_id = v_orig.organization_id
       AND (ld.business_id IS NULL OR ld.business_id = v_orig.business_id)
       AND CURRENT_DATE <= ld.lock_date
  ) INTO v_lock_exists;
  IF v_lock_exists THEN
    RAISE EXCEPTION 'Cannot post reversal: accounting period is locked. Move the lock date forward in Finance Settings to reverse.';
  END IF;

  -- Idempotency check on reversal request id.
  IF p_client_request_id IS NOT NULL THEN
    SELECT id INTO v_new_id
      FROM public.stock_adjustments
     WHERE organization_id = v_orig.organization_id
       AND business_id = v_orig.business_id
       AND client_request_id = p_client_request_id
     LIMIT 1;
    IF v_new_id IS NOT NULL THEN
      RETURN jsonb_build_object('success', true, 'reversal_id', v_new_id, 'idempotent', true);
    END IF;
  END IF;

  v_new_number := COALESCE(v_orig.adjustment_number, p_adjustment_id::text) || '-REV';

  INSERT INTO public.stock_adjustments (
    organization_id, business_id, branch_id, warehouse_id,
    adjustment_number, reason, notes, status, created_by,
    reverses_adjustment_id, reversal_reason, client_request_id
  ) VALUES (
    v_orig.organization_id, v_orig.business_id, v_orig.branch_id, v_orig.warehouse_id,
    v_new_number,
    v_orig.reason,
    'Reversal of ' || COALESCE(v_orig.adjustment_number, p_adjustment_id::text)
      || COALESCE(' — ' || p_reversal_reason, ''),
    'draft', p_user_id,
    p_adjustment_id, p_reversal_reason, p_client_request_id
  )
  RETURNING id INTO v_new_id;

  FOR v_item IN
    SELECT * FROM public.stock_adjustment_items WHERE adjustment_id = p_adjustment_id
  LOOP
    SELECT COALESCE(quantity, 0) INTO v_before
      FROM public.warehouse_stock
     WHERE product_id = v_item.product_id
       AND warehouse_id = v_item.warehouse_id
     LIMIT 1;
    v_before := COALESCE(v_before, 0);

    INSERT INTO public.stock_adjustment_items (
      adjustment_id, product_id, warehouse_id, branch_id,
      quantity_before, quantity_adjustment, quantity_after,
      unit_cost, notes
    ) VALUES (
      v_new_id, v_item.product_id, v_item.warehouse_id, v_item.branch_id,
      v_before, -v_item.quantity_adjustment, v_before - v_item.quantity_adjustment,
      v_item.unit_cost,
      'Reversal of line ' || v_item.id::text
    );
  END LOOP;

  v_apply := public.approve_stock_adjustment_atomic(v_new_id, p_user_id);
  IF NOT (v_apply->>'success')::boolean THEN
    RAISE EXCEPTION 'Reversal posting failed: %', v_apply->>'error';
  END IF;

  -- Link the original to the reversal and mark it reversed.
  UPDATE public.stock_adjustments
     SET reversed_by_adjustment_id = v_new_id,
         status = 'reversed'
   WHERE id = p_adjustment_id;

  RETURN jsonb_build_object(
    'success', true,
    'reversal_id', v_new_id,
    'reversed_adjustment_id', p_adjustment_id,
    'gl_posted', COALESCE((v_apply->>'gl_posted')::boolean, false),
    'journal_entry_id', v_apply->>'journal_entry_id'
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.reverse_stock_adjustment_atomic(uuid, uuid, text, uuid) TO authenticated, service_role;

-- G10. Backfill RPC for legacy approved adjustments with no journal entry.
-- Strictly per-row, finance-driven; uses today's resolver.
CREATE OR REPLACE FUNCTION public.backfill_missing_adjustment_je(
  p_adjustment_id uuid,
  p_user_id uuid
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_adj RECORD;
  v_item RECORD;
  v_inv uuid;
  v_legacy_adj uuid;
  v_offset uuid;
  v_resolved numeric;
  v_cost_value numeric;
  v_lines jsonb := '[]'::jsonb;
  v_journal_id uuid;
  v_total numeric := 0;
  v_je_exists boolean;
BEGIN
  SELECT * INTO v_adj FROM public.stock_adjustments WHERE id = p_adjustment_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Adjustment % not found', p_adjustment_id;
  END IF;
  IF v_adj.status <> 'approved' THEN
    RAISE EXCEPTION 'Backfill is only valid for approved adjustments (current: %)', v_adj.status;
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM public.journal_entries
     WHERE source_type = 'stock_adjustment' AND source_id = p_adjustment_id
  ) INTO v_je_exists;
  IF v_je_exists THEN
    RETURN jsonb_build_object('success', false, 'error', 'Journal entry already exists for this adjustment');
  END IF;

  SELECT inventory_account_id, adjustment_account_id
    INTO v_inv, v_legacy_adj
    FROM public.ensure_inventory_gl_accounts(v_adj.organization_id, v_adj.business_id);

  FOR v_item IN
    SELECT * FROM public.stock_adjustment_items WHERE adjustment_id = p_adjustment_id
  LOOP
    IF v_item.quantity_adjustment = 0 THEN CONTINUE; END IF;
    v_resolved := public.resolve_adjustment_unit_cost(
      v_adj.organization_id, v_adj.business_id, v_item.product_id, v_item.warehouse_id, v_item.unit_cost
    );
    IF v_resolved IS NULL OR v_resolved <= 0 THEN
      RAISE EXCEPTION 'Cannot backfill: no valuation cost for product %', v_item.product_id;
    END IF;
    v_cost_value := ABS(v_item.quantity_adjustment) * v_resolved;
    v_offset := public.resolve_adjustment_offset_account(
      v_adj.organization_id, v_adj.business_id, v_adj.reason,
      CASE WHEN v_item.quantity_adjustment > 0 THEN 1 ELSE -1 END
    );

    IF v_item.quantity_adjustment > 0 THEN
      v_lines := v_lines || jsonb_build_array(
        jsonb_build_object('account_id', v_inv, 'debit', v_cost_value, 'credit', 0,
                           'description', 'Backfill - Inventory Increase'),
        jsonb_build_object('account_id', v_offset, 'debit', 0, 'credit', v_cost_value,
                           'description', 'Backfill - Increase Offset')
      );
    ELSE
      v_lines := v_lines || jsonb_build_array(
        jsonb_build_object('account_id', v_offset, 'debit', v_cost_value, 'credit', 0,
                           'description', 'Backfill - Decrease Offset'),
        jsonb_build_object('account_id', v_inv, 'debit', 0, 'credit', v_cost_value,
                           'description', 'Backfill - Inventory Decrease')
      );
    END IF;
    v_total := v_total + v_cost_value;
  END LOOP;

  IF jsonb_array_length(v_lines) = 0 THEN
    RETURN jsonb_build_object('success', false, 'error', 'No postable lines on this adjustment');
  END IF;

  v_journal_id := public.post_journal_entry_atomic(
    _org_id          := v_adj.organization_id,
    _business_id     := v_adj.business_id,
    _entry_number    := public.get_next_journal_entry_number(v_adj.organization_id),
    _entry_date      := CURRENT_DATE,
    _reference       := 'ADJ-BACKFILL-' || LEFT(p_adjustment_id::text, 8),
    _description     := 'Stock adjustment backfill (' || COALESCE(v_adj.reason, 'unspecified') || ')',
    _source_type     := 'stock_adjustment',
    _source_id       := p_adjustment_id,
    _created_by      := p_user_id,
    _is_closing      := false,
    _is_adjusting    := false,
    _lines           := v_lines,
    _branch_id       := v_adj.branch_id
  );

  RETURN jsonb_build_object('success', true, 'journal_entry_id', v_journal_id, 'total_value', v_total);
END;
$$;

GRANT EXECUTE ON FUNCTION public.backfill_missing_adjustment_je(uuid, uuid) TO authenticated, service_role;

COMMENT ON FUNCTION public.approve_stock_adjustment_atomic(uuid, uuid) IS
  'Wave 2 — Approves an adjustment atomically. Resolves cost server-side, groups lines by reason-keyed offset account (shrinkage/overage/revaluation/legacy), and posts a single balanced JE. See ADR 0016.';
COMMENT ON FUNCTION public.reverse_stock_adjustment_atomic(uuid, uuid, text, uuid) IS
  'Wave 2 D2 — first-class reversal. Creates a mirror adjustment with negated quantities, posts the inverse JE via approve_stock_adjustment_atomic, and links both records via reverses_/reversed_by_adjustment_id.';
COMMENT ON FUNCTION public.backfill_missing_adjustment_je(uuid, uuid) IS
  'G10 — per-row backfill of journal entries for legacy approved adjustments that posted before the GL integrity fix. Strictly opt-in, finance-driven.';
