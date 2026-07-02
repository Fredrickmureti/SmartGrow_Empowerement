-- =====================================================================
-- Wave 12 — Journal Entry narration integrity (ADR-0020)
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Allow narrow, opt-in narration repair on posted JEs.
--    Only description + reference can change; every financial / lineage
--    column stays locked. Gated by a session GUC so day-to-day code paths
--    cannot accidentally edit posted-entry narrations.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.enforce_journal_entry_immutability()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $function$
DECLARE
  reset_org      TEXT;
  narration_flag TEXT;
BEGIN
  reset_org := current_setting('app.reset_in_progress', true);
  IF reset_org IS NOT NULL AND reset_org <> ''
     AND COALESCE(NEW.organization_id, OLD.organization_id)::text = reset_org THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
  END IF;

  IF OLD.status NOT IN ('posted', 'voided', 'reversed') THEN
    RETURN NEW;
  END IF;

  -- ADR-0020: opt-in narration repair. Only description / reference may
  -- change. Every financial, lineage and status field must stay equal.
  narration_flag := current_setting('app.je_narration_repair', true);
  IF narration_flag = 'on'
     AND NEW.status         IS NOT DISTINCT FROM OLD.status
     AND NEW.entry_date     IS NOT DISTINCT FROM OLD.entry_date
     AND NEW.entry_number   IS NOT DISTINCT FROM OLD.entry_number
     AND NEW.source_type    IS NOT DISTINCT FROM OLD.source_type
     AND NEW.source_id      IS NOT DISTINCT FROM OLD.source_id
     AND NEW.source_subtype IS NOT DISTINCT FROM OLD.source_subtype
     AND NEW.total_debit    IS NOT DISTINCT FROM OLD.total_debit
     AND NEW.total_credit   IS NOT DISTINCT FROM OLD.total_credit
     AND NEW.organization_id IS NOT DISTINCT FROM OLD.organization_id
     AND NEW.business_id    IS NOT DISTINCT FROM OLD.business_id
     AND NEW.is_adjusting   IS NOT DISTINCT FROM OLD.is_adjusting
     AND NEW.is_closing     IS NOT DISTINCT FROM OLD.is_closing
     AND NEW.is_reversing   IS NOT DISTINCT FROM OLD.is_reversing
     AND NEW.is_reversal    IS NOT DISTINCT FROM OLD.is_reversal
     AND NEW.reversal_of_id IS NOT DISTINCT FROM OLD.reversal_of_id
     AND NEW.reversed_entry_id IS NOT DISTINCT FROM OLD.reversed_entry_id
     AND NEW.posted_at      IS NOT DISTINCT FROM OLD.posted_at
     AND NEW.posted_by      IS NOT DISTINCT FROM OLD.posted_by
  THEN
    RETURN NEW;
  END IF;

  IF OLD.status = 'posted' AND NEW.status IN ('voided', 'reversed') THEN
    IF NEW.entry_date IS DISTINCT FROM OLD.entry_date
       OR NEW.description IS DISTINCT FROM OLD.description
       OR NEW.reference IS DISTINCT FROM OLD.reference
       OR NEW.entry_number IS DISTINCT FROM OLD.entry_number
       OR NEW.source_type IS DISTINCT FROM OLD.source_type
       OR NEW.source_id IS DISTINCT FROM OLD.source_id
       OR NEW.source_subtype IS DISTINCT FROM OLD.source_subtype
       OR NEW.is_adjusting IS DISTINCT FROM OLD.is_adjusting
       OR NEW.is_closing IS DISTINCT FROM OLD.is_closing
       OR NEW.is_reversing IS DISTINCT FROM OLD.is_reversing
       OR NEW.is_reversal IS DISTINCT FROM OLD.is_reversal
       OR NEW.reversal_of_id IS DISTINCT FROM OLD.reversal_of_id
       OR NEW.reversed_entry_id IS DISTINCT FROM OLD.reversed_entry_id
       OR NEW.posted_at IS DISTINCT FROM OLD.posted_at
       OR NEW.posted_by IS DISTINCT FROM OLD.posted_by
       OR NEW.total_debit IS DISTINCT FROM OLD.total_debit
       OR NEW.total_credit IS DISTINCT FROM OLD.total_credit
       OR NEW.organization_id IS DISTINCT FROM OLD.organization_id
       OR NEW.business_id IS DISTINCT FROM OLD.business_id
    THEN
      RAISE EXCEPTION 'Cannot modify core fields of a posted journal entry. Only voiding/reversing bookkeeping fields are allowed.';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.status IN ('voided', 'reversed') THEN
    RAISE EXCEPTION 'Cannot modify a % journal entry.', OLD.status;
  END IF;

  RAISE EXCEPTION 'Cannot modify a posted journal entry. Create a reversing entry or void it instead.';
END;
$function$;

-- ---------------------------------------------------------------------
-- 2. approve_stock_adjustment_atomic — use adjustment_number, not UUID.
-- ---------------------------------------------------------------------
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
  v_adj_number text;
  v_inventory_account_id UUID;
  v_adjustment_account_id UUID;
  v_offset_account UUID;
  v_reason text;
  v_journal_id UUID;
  v_entry_number text;
  v_resolved_cost numeric;
  v_cost_value numeric;
  v_total_value numeric := 0;
  v_locked_qty numeric;
  v_inv_debit  numeric := 0;
  v_inv_credit numeric := 0;
  v_offset_rec RECORD;
  v_lines jsonb := '[]'::jsonb;
BEGIN
  SELECT id, organization_id, business_id, branch_id, status, reason, adjustment_number
    INTO v_adjustment
    FROM stock_adjustments
   WHERE id = p_adjustment_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'Adjustment not found');
  END IF;
  IF v_adjustment.status = 'approved' THEN
    RETURN jsonb_build_object('success', false, 'error', 'Adjustment is already approved');
  END IF;
  IF v_adjustment.status NOT IN ('draft', 'pending_approval') THEN
    RETURN jsonb_build_object('success', false, 'error',
      'Adjustment cannot be approved (current status: ' || v_adjustment.status || ')');
  END IF;

  v_org_id     := v_adjustment.organization_id;
  v_biz_id     := v_adjustment.business_id;
  v_branch_id  := v_adjustment.branch_id;
  v_reason     := v_adjustment.reason;
  v_adj_number := v_adjustment.adjustment_number;

  IF v_biz_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error',
      'Adjustment has no business_id; cannot post to GL');
  END IF;

  SELECT inventory_account_id, adjustment_account_id
    INTO v_inventory_account_id, v_adjustment_account_id
    FROM public.ensure_inventory_gl_accounts(v_org_id, v_biz_id);

  IF v_inventory_account_id IS NULL OR v_adjustment_account_id IS NULL THEN
    RAISE EXCEPTION 'Cannot approve stock adjustment: inventory or adjustment GL account not provisioned for company %', v_biz_id;
  END IF;

  PERFORM public.ensure_inventory_reason_gl_accounts(v_org_id, v_biz_id);

  CREATE TEMP TABLE IF NOT EXISTS _adj_offset_acc (
    offset_account_id uuid PRIMARY KEY,
    inv_debit  numeric NOT NULL DEFAULT 0,
    inv_credit numeric NOT NULL DEFAULT 0,
    off_debit  numeric NOT NULL DEFAULT 0,
    off_credit numeric NOT NULL DEFAULT 0
  ) ON COMMIT DROP;
  TRUNCATE TABLE _adj_offset_acc;

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
        RAISE EXCEPTION
          'OPENING_STOCK_REQUIRES_COST: no valuation cost for product % (warehouse %). Provide a positive unit_cost on the adjustment line, or set the product cost first.',
          v_item.product_id, v_item.warehouse_id
        USING ERRCODE = 'check_violation';
      END IF;
      IF v_item.unit_cost IS DISTINCT FROM v_resolved_cost THEN
        UPDATE public.stock_adjustment_items SET unit_cost = v_resolved_cost WHERE id = v_item.id;
      END IF;
    END IF;

    INSERT INTO stock_movements (
      organization_id, business_id, branch_id, product_id, movement_type,
      quantity, unit_cost, warehouse_id,
      reference_type, reference_id, notes, created_by
    ) VALUES (
      v_org_id, v_biz_id, v_branch_id, v_item.product_id, 'adjustment',
      v_item.quantity_adjustment, v_resolved_cost, v_item.warehouse_id,
      'stock_adjustment', p_adjustment_id, v_item.notes, p_user_id
    );

    v_cost_value := ABS(v_item.quantity_adjustment) * COALESCE(v_resolved_cost, 0);
    IF v_cost_value > 0 THEN
      v_offset_account := public.resolve_adjustment_offset_account(
        v_org_id, v_biz_id, v_reason, v_item.quantity_adjustment
      );
      IF v_offset_account IS NULL THEN
        RAISE EXCEPTION 'Cannot approve stock adjustment: no offset GL account resolved for reason %', v_reason;
      END IF;

      INSERT INTO _adj_offset_acc (offset_account_id, inv_debit, inv_credit, off_debit, off_credit)
      VALUES (
        v_offset_account,
        CASE WHEN v_item.quantity_adjustment > 0 THEN v_cost_value ELSE 0 END,
        CASE WHEN v_item.quantity_adjustment < 0 THEN v_cost_value ELSE 0 END,
        CASE WHEN v_item.quantity_adjustment < 0 THEN v_cost_value ELSE 0 END,
        CASE WHEN v_item.quantity_adjustment > 0 THEN v_cost_value ELSE 0 END
      )
      ON CONFLICT (offset_account_id) DO UPDATE
        SET inv_debit  = _adj_offset_acc.inv_debit  + EXCLUDED.inv_debit,
            inv_credit = _adj_offset_acc.inv_credit + EXCLUDED.inv_credit,
            off_debit  = _adj_offset_acc.off_debit  + EXCLUDED.off_debit,
            off_credit = _adj_offset_acc.off_credit + EXCLUDED.off_credit;

      v_total_value := v_total_value + v_cost_value;
    END IF;
  END LOOP;

  UPDATE stock_adjustments
     SET status = 'approved', approved_by = p_user_id, approved_at = now()
   WHERE id = p_adjustment_id;

  IF v_total_value > 0 THEN
    FOR v_offset_rec IN SELECT * FROM _adj_offset_acc LOOP
      v_inv_debit  := v_inv_debit  + v_offset_rec.inv_debit;
      v_inv_credit := v_inv_credit + v_offset_rec.inv_credit;
      IF v_offset_rec.off_debit > 0 THEN
        v_lines := v_lines || jsonb_build_array(jsonb_build_object(
          'account_id', v_offset_rec.offset_account_id,
          'debit', v_offset_rec.off_debit, 'credit', 0,
          'description', 'Stock adjustment offset'));
      END IF;
      IF v_offset_rec.off_credit > 0 THEN
        v_lines := v_lines || jsonb_build_array(jsonb_build_object(
          'account_id', v_offset_rec.offset_account_id,
          'debit', 0, 'credit', v_offset_rec.off_credit,
          'description', 'Stock adjustment offset'));
      END IF;
    END LOOP;

    IF v_inv_debit > 0 THEN
      v_lines := v_lines || jsonb_build_array(jsonb_build_object(
        'account_id', v_inventory_account_id, 'debit', v_inv_debit, 'credit', 0,
        'description', 'Inventory'));
    END IF;
    IF v_inv_credit > 0 THEN
      v_lines := v_lines || jsonb_build_array(jsonb_build_object(
        'account_id', v_inventory_account_id, 'debit', 0, 'credit', v_inv_credit,
        'description', 'Inventory'));
    END IF;

    v_entry_number := public.get_next_journal_entry_number(v_org_id);

    -- ADR-0020: human-readable narration. UUID stays internal as source_id.
    v_journal_id := public.post_journal_entry_atomic(
      _org_id          := v_org_id,
      _business_id     := v_biz_id,
      _entry_number    := v_entry_number,
      _entry_date      := CURRENT_DATE,
      _reference       := COALESCE(v_adj_number, 'ADJ-' || LEFT(p_adjustment_id::text, 8)),
      _description     := 'Stock adjustment '
                          || COALESCE(v_adj_number, 'ADJ-' || LEFT(p_adjustment_id::text, 8))
                          || ' (' || COALESCE(v_reason, 'unspecified') || ')',
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
    'gl_posted', v_journal_id IS NOT NULL,
    'journal_entry_id', v_journal_id,
    'total_value', v_total_value
  );
END;
$function$;

GRANT EXECUTE ON FUNCTION public.approve_stock_adjustment_atomic(uuid, uuid) TO authenticated;

COMMENT ON FUNCTION public.approve_stock_adjustment_atomic(uuid, uuid) IS
  'Wave 12 (ADR-0020) — JE description and reference use adjustment_number instead of UUID.';

-- ---------------------------------------------------------------------
-- 3. backfill_missing_adjustment_je — same narration fix.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.backfill_missing_adjustment_je(p_adjustment_id uuid, p_user_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_adj         RECORD;
  v_item        RECORD;
  v_inv         uuid;
  v_offset      uuid;
  v_lines       jsonb := '[]'::jsonb;
  v_total       numeric := 0;
  v_resolved    numeric;
  v_cost_value  numeric;
  v_journal_id  uuid;
BEGIN
  SELECT * INTO v_adj FROM public.stock_adjustments WHERE id = p_adjustment_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'Adjustment not found');
  END IF;
  IF v_adj.status <> 'approved' THEN
    RETURN jsonb_build_object('success', false, 'error', 'Only approved adjustments can be backfilled');
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.journal_entries
    WHERE source_type = 'stock_adjustment' AND source_id = p_adjustment_id
  ) THEN
    RETURN jsonb_build_object('success', false, 'error', 'Adjustment already has a journal entry');
  END IF;

  SELECT inventory_account_id INTO v_inv
    FROM public.ensure_inventory_gl_accounts(v_adj.organization_id, v_adj.business_id);
  IF v_inv IS NULL THEN
    RAISE EXCEPTION 'Cannot backfill: inventory account not provisioned';
  END IF;
  PERFORM public.ensure_inventory_reason_gl_accounts(v_adj.organization_id, v_adj.business_id);

  FOR v_item IN SELECT * FROM public.stock_adjustment_items WHERE adjustment_id = p_adjustment_id LOOP
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
    _reference       := 'BACKFILL-' || COALESCE(v_adj.adjustment_number, LEFT(p_adjustment_id::text, 8)),
    _description     := 'Stock adjustment backfill '
                        || COALESCE(v_adj.adjustment_number, LEFT(p_adjustment_id::text, 8))
                        || ' (' || COALESCE(v_adj.reason, 'unspecified') || ')',
    _source_type     := 'stock_adjustment',
    _source_id       := p_adjustment_id,
    _created_by      := p_user_id,
    _is_closing      := false,
    _is_adjusting    := false,
    _lines           := v_lines,
    _branch_id       := v_adj.branch_id
  );

  INSERT INTO public.stock_adjustment_backfill_log
    (organization_id, business_id, adjustment_id, journal_entry_id,
     posted_by, total_value, reason, note)
  VALUES
    (v_adj.organization_id, v_adj.business_id, p_adjustment_id, v_journal_id,
     p_user_id, v_total, v_adj.reason,
     'Posted at today''s resolved cost; original adjustment date '
       || v_adj.adjustment_date::text);

  RETURN jsonb_build_object('success', true, 'journal_entry_id', v_journal_id, 'total_value', v_total);
END;
$$;

GRANT EXECUTE ON FUNCTION public.backfill_missing_adjustment_je(uuid, uuid) TO authenticated, service_role;

COMMENT ON FUNCTION public.backfill_missing_adjustment_je(uuid, uuid) IS
  'Wave 12 (ADR-0020) — uses adjustment_number for the JE description and reference.';

-- ---------------------------------------------------------------------
-- 4. One-shot narration repair for historical UUID-shaped descriptions.
--    Idempotent: regex stops matching once a row is rewritten.
--    Pure description/reference rewrite — gated by the new GUC so the
--    immutability trigger permits exactly this kind of repair.
-- ---------------------------------------------------------------------
DO $$
BEGIN
  PERFORM set_config('app.je_narration_repair', 'on', true);

  UPDATE public.journal_entries je
  SET description = 'Stock adjustment '
                    || COALESCE(sa.adjustment_number, LEFT(sa.id::text, 8))
                    || ' (' || COALESCE(sa.reason, 'unspecified') || ')',
      reference   = COALESCE(je.reference, sa.adjustment_number, LEFT(sa.id::text, 8))
  FROM public.stock_adjustments sa
  WHERE je.source_type = 'stock_adjustment'
    AND je.source_id   = sa.id
    AND je.description ~ '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
END $$;