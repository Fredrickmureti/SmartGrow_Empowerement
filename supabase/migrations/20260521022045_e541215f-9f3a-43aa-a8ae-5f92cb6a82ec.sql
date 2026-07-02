
-- =====================================================================
-- Wave 5 — Inventory Adjustment ↔ GL (G6 + backfill audit + pagination)
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. G6 — preview RPC for the adjustment-dialog offset-account hint.
--    Read-only wrapper around resolve_adjustment_offset_account; returns
--    the resolved account's code + name so the operator can see which
--    GL account the reason will hit before they submit.
-- ---------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.preview_adjustment_offset_account(
  p_business_id uuid,
  p_reason      text,
  p_sign        int DEFAULT 1
) RETURNS TABLE (
  account_id   uuid,
  account_code text,
  account_name text
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_org_id uuid;
  v_acc_id uuid;
BEGIN
  IF p_business_id IS NULL OR p_reason IS NULL THEN
    RAISE EXCEPTION 'preview_adjustment_offset_account requires business_id and reason';
  END IF;

  SELECT organization_id INTO v_org_id
    FROM public.businesses WHERE id = p_business_id;

  IF v_org_id IS NULL THEN
    RAISE EXCEPTION 'Unknown business %', p_business_id;
  END IF;

  v_acc_id := public.resolve_adjustment_offset_account(
    v_org_id, p_business_id, p_reason, COALESCE(p_sign, 1)
  );

  RETURN QUERY
    SELECT a.id, a.code, a.name
      FROM public.accounts a
     WHERE a.id = v_acc_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.preview_adjustment_offset_account(uuid, text, int)
  TO authenticated, service_role;

COMMENT ON FUNCTION public.preview_adjustment_offset_account(uuid, text, int) IS
  'Wave 5 G6 — read-only preview of the offset account resolve_adjustment_offset_account would pick for a given reason. Used by the Inventory adjustment dialog to show the operator which GL account will be hit.';

-- ---------------------------------------------------------------------
-- 2. Backfill audit trail (new finding — observability gap on a
--    function that materially moves the trial balance).
-- ---------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.stock_adjustment_backfill_log (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id   uuid NOT NULL,
  business_id       uuid NOT NULL,
  adjustment_id     uuid NOT NULL
    REFERENCES public.stock_adjustments(id) ON DELETE RESTRICT,
  journal_entry_id  uuid NOT NULL
    REFERENCES public.journal_entries(id) ON DELETE RESTRICT,
  posted_by         uuid NOT NULL,
  posted_at         timestamptz NOT NULL DEFAULT now(),
  total_value       numeric(20,4) NOT NULL,
  reason            text,
  note              text
);

CREATE INDEX IF NOT EXISTS idx_stock_adj_backfill_adj
  ON public.stock_adjustment_backfill_log (adjustment_id);
CREATE INDEX IF NOT EXISTS idx_stock_adj_backfill_org_biz
  ON public.stock_adjustment_backfill_log (organization_id, business_id, posted_at DESC);

ALTER TABLE public.stock_adjustment_backfill_log ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS backfill_log_select ON public.stock_adjustment_backfill_log;
CREATE POLICY backfill_log_select ON public.stock_adjustment_backfill_log
  FOR SELECT TO authenticated
  USING (
    public.user_can_access_business(auth.uid(), business_id)
  );

-- Writes happen only through backfill_missing_adjustment_je (SECURITY DEFINER)
-- so we intentionally do NOT add INSERT/UPDATE/DELETE policies for the
-- authenticated role. The RPC inserts under its definer privileges.

COMMENT ON TABLE public.stock_adjustment_backfill_log IS
  'Wave 5 — immutable audit trail for every successful call to backfill_missing_adjustment_je. Records who posted the legacy backfill, when, the resolved cost basis, and the JE id. Read-only to tenants.';

-- ---------------------------------------------------------------------
-- 3. Update backfill_missing_adjustment_je to write the audit row in
--    the same transaction as the JE post. Signature preserved.
-- ---------------------------------------------------------------------

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

  -- Wave 5 — audit trail (same transaction as the JE post).
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
  'Wave 5 — per-row backfill of journal entries for legacy approved adjustments. Posts a balanced JE at today''s resolved cost AND writes an immutable audit row into stock_adjustment_backfill_log. Strictly opt-in, finance-driven.';

-- ---------------------------------------------------------------------
-- 4. Lower default page size on the missing-JE detector. The previous
--    default (500) is fine for the integrity panel but can hammer the
--    query for tenants with very large legacy backlogs. Default to 100;
--    the hook can still pass a larger explicit limit when needed.
-- ---------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.list_adjustments_missing_journals(
  p_organization_id uuid,
  p_business_id uuid,
  p_branch_id uuid DEFAULT NULL,
  p_limit integer DEFAULT 100,
  p_offset integer DEFAULT 0
)
RETURNS TABLE (
  id uuid,
  adjustment_number text,
  adjustment_date date,
  reason text,
  status text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT sa.id, sa.adjustment_number, sa.adjustment_date, sa.reason, sa.status
    FROM public.stock_adjustments sa
   WHERE sa.organization_id = p_organization_id
     AND sa.business_id     = p_business_id
     AND sa.status          = 'approved'
     AND (p_branch_id IS NULL OR sa.branch_id = p_branch_id)
     AND NOT EXISTS (
       SELECT 1 FROM public.journal_entries je
        WHERE je.source_type = 'stock_adjustment'
          AND je.source_id   = sa.id
     )
   ORDER BY sa.adjustment_date DESC
   LIMIT GREATEST(p_limit, 1)
   OFFSET GREATEST(p_offset, 0);
$$;

GRANT EXECUTE ON FUNCTION public.list_adjustments_missing_journals(uuid, uuid, uuid, integer, integer)
  TO authenticated, service_role;

COMMENT ON FUNCTION public.list_adjustments_missing_journals(uuid, uuid, uuid, integer, integer) IS
  'ADR 0016 (Wave 5) — paginated NOT-EXISTS detector for approved adjustments with no JE. Default page size 100. Used by the Inventory Reconciliation card and the Accounting Integrity panel.';
