-- ============================================================
-- Repair confirm_invoice_and_release_stock_atomic regression
-- (ADR 0026 follow-up). The 5-arg overload still called the
-- removed 4-arg confirm_invoice_atomic(p_cogs_lines). Redefine
-- it to delegate to the canonical 3-arg confirm + conditional
-- goods-issue, and collapse to a single authoritative overload.
-- ============================================================

-- Drop the redundant 3-arg wrapper (no JS caller; superseded by the
-- 5-arg overload which carries the release-mode flag the UI passes).
DROP FUNCTION IF EXISTS public.confirm_invoice_and_release_stock_atomic(uuid, uuid, jsonb);
-- Drop any legacy 4-arg overload if it lingers.
DROP FUNCTION IF EXISTS public.confirm_invoice_and_release_stock_atomic(uuid, uuid, jsonb, jsonb);

CREATE OR REPLACE FUNCTION public.confirm_invoice_and_release_stock_atomic(
  p_invoice_id uuid,
  p_user_id uuid,
  p_main_lines jsonb,
  p_release_stock boolean DEFAULT true,
  p_warehouse_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_confirm  jsonb;
  v_dn_id    uuid;
  v_delivery jsonb;
BEGIN
  -- Canonical confirm: posts Revenue/AR JE, flips status, and auto-creates a
  -- PENDING delivery note for stockable direct invoices. COGS is NOT posted
  -- here (ADR 0026 — COGS posts only at goods-issue).
  v_confirm := public.confirm_invoice_atomic(
    p_invoice_id := p_invoice_id,
    p_user_id    := p_user_id,
    p_main_lines := p_main_lines
  );

  -- Resolve the delivery note to release: prefer the one the confirm just
  -- created, then fall back to any DN tied to this invoice or its SO.
  v_dn_id := NULLIF(v_confirm->>'delivery_note_id', '')::uuid;

  IF v_dn_id IS NULL THEN
    SELECT dn.id INTO v_dn_id
      FROM public.delivery_notes dn
      JOIN public.invoices i ON i.id = p_invoice_id
     WHERE dn.organization_id = i.organization_id
       AND dn.business_id     = i.business_id
       AND (
         dn.source_invoice_id = p_invoice_id
         OR (i.source_sales_order_id IS NOT NULL AND dn.sales_order_id = i.source_sales_order_id)
       )
       AND dn.status = 'pending'
     ORDER BY dn.created_at DESC
     LIMIT 1;
  END IF;

  -- Convenience path: release goods immediately (inventory movements + COGS GL).
  -- Enterprise path (p_release_stock = false): leave DN pending for warehouse
  -- to confirm later. p_warehouse_id is accepted for signature/API stability;
  -- complete_delivery_atomic resolves the branch's active warehouse itself.
  IF p_release_stock AND v_dn_id IS NOT NULL THEN
    v_delivery := public.complete_delivery_atomic(
      p_dn_id               := v_dn_id,
      p_user_id             := p_user_id,
      p_received_by         := NULL,
      p_pod                 := NULL,
      p_received_by_user_id := p_user_id
    );
    IF NOT COALESCE((v_delivery->>'success')::boolean, false) THEN
      RAISE EXCEPTION 'Stock release failed: %', COALESCE(v_delivery->>'error', 'unknown error');
    END IF;
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'journal_entry_id', v_confirm->>'journal_entry_id',
    'delivery_note_id', v_dn_id,
    'auto_delivery_created', COALESCE((v_confirm->>'auto_delivery_created')::boolean, false),
    'stock_released', p_release_stock AND v_dn_id IS NOT NULL,
    'delivery_result', v_delivery
  );
END;
$function$;

GRANT EXECUTE ON FUNCTION public.confirm_invoice_and_release_stock_atomic(uuid, uuid, jsonb, boolean, uuid) TO authenticated;

COMMENT ON FUNCTION public.confirm_invoice_and_release_stock_atomic(uuid, uuid, jsonb, boolean, uuid) IS
  'Confirms an invoice (Revenue/AR JE + status) via confirm_invoice_atomic, which auto-creates a pending DN for stockable lines. When p_release_stock is true, immediately completes the DN (inventory movements + COGS at goods-issue). When false, leaves the DN pending for later warehouse confirmation. ADR 0026.';
