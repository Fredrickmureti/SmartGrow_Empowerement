-- =====================================================================
-- Purchase Returns — Phase 1: schema, traceability, access
-- =====================================================================

-- 1. Header: lineage, execution + settlement links, lifecycle stamps
ALTER TABLE public.purchase_returns
  ADD COLUMN IF NOT EXISTS purchase_order_id uuid REFERENCES public.purchase_orders(id),
  ADD COLUMN IF NOT EXISTS goods_receipt_id uuid REFERENCES public.goods_receipts(id),
  ADD COLUMN IF NOT EXISTS warehouse_id uuid REFERENCES public.warehouses(id),
  ADD COLUMN IF NOT EXISTS wms_return_order_id uuid REFERENCES public.wms_return_orders(id),
  ADD COLUMN IF NOT EXISTS vendor_credit_note_id uuid REFERENCES public.vendor_credit_notes(id),
  ADD COLUMN IF NOT EXISTS approval_request_id uuid REFERENCES public.approval_requests(id),
  ADD COLUMN IF NOT EXISTS return_kind text NOT NULL DEFAULT 'goods',
  ADD COLUMN IF NOT EXISTS reason_code text,
  ADD COLUMN IF NOT EXISTS rma_reference text,
  ADD COLUMN IF NOT EXISTS exchange_rate numeric NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS row_version integer NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS submitted_at timestamptz,
  ADD COLUMN IF NOT EXISTS submitted_by uuid,
  ADD COLUMN IF NOT EXISTS approved_at timestamptz,
  ADD COLUMN IF NOT EXISTS approved_by uuid,
  ADD COLUMN IF NOT EXISTS rejected_at timestamptz,
  ADD COLUMN IF NOT EXISTS rejected_by uuid,
  ADD COLUMN IF NOT EXISTS rejected_reason text,
  ADD COLUMN IF NOT EXISTS dispatched_at timestamptz,
  ADD COLUMN IF NOT EXISTS dispatched_by uuid,
  ADD COLUMN IF NOT EXISTS acknowledged_at timestamptz,
  ADD COLUMN IF NOT EXISTS acknowledged_by uuid,
  ADD COLUMN IF NOT EXISTS credited_at timestamptz,
  ADD COLUMN IF NOT EXISTS closed_at timestamptz,
  ADD COLUMN IF NOT EXISTS closed_by uuid,
  ADD COLUMN IF NOT EXISTS cancelled_at timestamptz,
  ADD COLUMN IF NOT EXISTS cancelled_by uuid;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'purchase_returns_return_kind_chk'
  ) THEN
    ALTER TABLE public.purchase_returns
      ADD CONSTRAINT purchase_returns_return_kind_chk
      CHECK (return_kind IN ('goods', 'financial'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'purchase_returns_status_chk'
  ) THEN
    ALTER TABLE public.purchase_returns
      ADD CONSTRAINT purchase_returns_status_chk
      CHECK (status IN (
        'draft','submitted','approved','rejected',
        'dispatched','acknowledged','credited','closed','cancelled',
        -- legacy values retained so historical rows stay readable
        'pending','processed'
      ));
  END IF;
END $$;

ALTER TABLE public.purchase_returns ALTER COLUMN status SET DEFAULT 'draft';
ALTER TABLE public.purchase_returns ALTER COLUMN reason DROP NOT NULL;

-- 2. Lines: receipt lineage + inventory identity
ALTER TABLE public.purchase_return_items
  ADD COLUMN IF NOT EXISTS goods_receipt_item_id uuid REFERENCES public.goods_receipt_items(id),
  ADD COLUMN IF NOT EXISTS lot_number text,
  ADD COLUMN IF NOT EXISTS serial_number text,
  ADD COLUMN IF NOT EXISTS location_id uuid,
  ADD COLUMN IF NOT EXISTS unit_cost_basis numeric;

-- 3. Append-only lifecycle / audit log
CREATE TABLE IF NOT EXISTS public.purchase_return_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  business_id uuid NOT NULL,
  purchase_return_id uuid NOT NULL REFERENCES public.purchase_returns(id) ON DELETE CASCADE,
  event_type text NOT NULL,
  from_status text,
  to_status text,
  actor_user_id uuid,
  governance_mode text,
  approval_request_id uuid,
  journal_entry_id uuid,
  vendor_credit_note_id uuid,
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT ON public.purchase_return_events TO authenticated;
GRANT ALL ON public.purchase_return_events TO service_role;
ALTER TABLE public.purchase_return_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS purchase_return_events_select ON public.purchase_return_events;
CREATE POLICY purchase_return_events_select
  ON public.purchase_return_events FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.purchase_returns pr
       WHERE pr.id = purchase_return_events.purchase_return_id
         AND public.user_can_access_business(auth.uid(), pr.business_id)
         AND public.user_can_access_branch(auth.uid(), pr.branch_id)
         AND public.user_has_module_permission(auth.uid(), pr.organization_id, pr.business_id, 'purchases', 'read')
    )
  );

CREATE INDEX IF NOT EXISTS idx_pr_events_return ON public.purchase_return_events(purchase_return_id, created_at DESC);

-- 4. Integrity indexes
CREATE UNIQUE INDEX IF NOT EXISTS uq_purchase_returns_business_number
  ON public.purchase_returns(business_id, return_number);

CREATE UNIQUE INDEX IF NOT EXISTS uq_purchase_returns_credit_note
  ON public.purchase_returns(vendor_credit_note_id)
  WHERE vendor_credit_note_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_purchase_returns_grn ON public.purchase_returns(goods_receipt_id);
CREATE INDEX IF NOT EXISTS idx_purchase_returns_po ON public.purchase_returns(purchase_order_id);
CREATE INDEX IF NOT EXISTS idx_pri_grn_item ON public.purchase_return_items(goods_receipt_item_id);

-- 5. Line-level RLS parity with the v2 header policies
DROP POLICY IF EXISTS "Users can manage purchase return items" ON public.purchase_return_items;

DROP POLICY IF EXISTS purchase_return_items_select_v2 ON public.purchase_return_items;
CREATE POLICY purchase_return_items_select_v2
  ON public.purchase_return_items FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.purchase_returns pr
     WHERE pr.id = purchase_return_items.purchase_return_id
       AND public.user_can_access_business(auth.uid(), pr.business_id)
       AND public.user_can_access_branch(auth.uid(), pr.branch_id)
       AND public.user_has_module_permission(auth.uid(), pr.organization_id, pr.business_id, 'purchases', 'read')
  ));

DROP POLICY IF EXISTS purchase_return_items_write_v2 ON public.purchase_return_items;
CREATE POLICY purchase_return_items_write_v2
  ON public.purchase_return_items FOR ALL TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.purchase_returns pr
     WHERE pr.id = purchase_return_items.purchase_return_id
       AND public.user_can_access_business(auth.uid(), pr.business_id)
       AND public.user_can_access_branch(auth.uid(), pr.branch_id)
       AND public.user_has_module_permission(auth.uid(), pr.organization_id, pr.business_id, 'purchases', 'write')
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM public.purchase_returns pr
     WHERE pr.id = purchase_return_items.purchase_return_id
       AND public.user_can_access_business(auth.uid(), pr.business_id)
       AND public.user_can_access_branch(auth.uid(), pr.branch_id)
       AND public.user_has_module_permission(auth.uid(), pr.organization_id, pr.business_id, 'purchases', 'write')
  ));

-- 6. Numbering: business-scoped, concurrency-safe (mirrors sales returns)
DROP FUNCTION IF EXISTS public.get_next_purchase_return_number(uuid);

CREATE OR REPLACE FUNCTION public.get_next_purchase_return_number(
  _org_id uuid,
  _business_id uuid DEFAULT NULL
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  next_num integer;
BEGIN
  IF _business_id IS NULL THEN
    RAISE EXCEPTION 'business_id is required for purchase return numbering (multi-company isolation)';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('purchase_returns_' || _business_id::text));

  SELECT COALESCE(MAX(
    CASE WHEN return_number ~ '\d+$'
      THEN CAST(substring(return_number FROM '\d+$') AS integer)
      ELSE 0
    END
  ), 0) + 1
  INTO next_num
  FROM public.purchase_returns
  WHERE organization_id = _org_id
    AND business_id = _business_id;

  RETURN 'PR-' || LPAD(next_num::text, 5, '0');
END;
$$;

REVOKE ALL ON FUNCTION public.get_next_purchase_return_number(uuid, uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.get_next_purchase_return_number(uuid, uuid) TO authenticated, service_role;