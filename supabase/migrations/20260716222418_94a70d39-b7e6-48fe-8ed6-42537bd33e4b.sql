
-- =====================================================================
-- ADR-0069 · Phase D — Inbound shipments (ASN) + GRN discrepancies
-- =====================================================================

-- ---------- Enums ----------------------------------------------------
DO $$ BEGIN
  CREATE TYPE public.inbound_shipment_status AS ENUM
    ('draft','dispatched','in_transit','arrived','received','cancelled');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE public.goods_receipt_discrepancy_type AS ENUM
    ('over','short','damaged','wrong_item','expired','quality_hold');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE public.goods_receipt_discrepancy_resolution AS ENUM
    ('pending','vendor_credit','insurance_claim','accept_and_move_on','return_to_vendor');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ---------- 1. inbound_shipments ------------------------------------
CREATE TABLE IF NOT EXISTS public.inbound_shipments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  business_id uuid NOT NULL,
  branch_id uuid,
  purchase_order_id uuid REFERENCES public.purchase_orders(id) ON DELETE SET NULL,
  vendor_id uuid REFERENCES public.contacts(id) ON DELETE RESTRICT,
  shipment_number text NOT NULL,
  carrier text,
  tracking_number text,
  status public.inbound_shipment_status NOT NULL DEFAULT 'draft',
  expected_arrival_at timestamptz,
  dispatched_at timestamptz,
  arrived_at timestamptz,
  received_at timestamptz,
  warehouse_id uuid REFERENCES public.warehouses(id) ON DELETE RESTRICT,
  notes text,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (business_id, shipment_number)
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.inbound_shipments TO authenticated;
GRANT ALL ON public.inbound_shipments TO service_role;

ALTER TABLE public.inbound_shipments ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS inbound_shipments_select ON public.inbound_shipments;
CREATE POLICY inbound_shipments_select ON public.inbound_shipments
  FOR SELECT TO authenticated
  USING (
    public.user_can_access_business(auth.uid(), business_id)
    AND (branch_id IS NULL OR public.can_access_branch(auth.uid(), branch_id))
  );

DROP POLICY IF EXISTS inbound_shipments_write ON public.inbound_shipments;
CREATE POLICY inbound_shipments_write ON public.inbound_shipments
  FOR ALL TO authenticated
  USING (
    public.user_can_access_business(auth.uid(), business_id)
    AND (branch_id IS NULL OR public.can_access_branch(auth.uid(), branch_id))
    AND public.user_has_module_permission(auth.uid(), business_id, 'inventory', 'write')
  )
  WITH CHECK (
    public.user_can_access_business(auth.uid(), business_id)
    AND (branch_id IS NULL OR public.can_access_branch(auth.uid(), branch_id))
    AND public.user_has_module_permission(auth.uid(), business_id, 'inventory', 'write')
  );

CREATE INDEX IF NOT EXISTS idx_inbound_shipments_biz_status
  ON public.inbound_shipments (business_id, status);
CREATE INDEX IF NOT EXISTS idx_inbound_shipments_po
  ON public.inbound_shipments (purchase_order_id) WHERE purchase_order_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_inbound_shipments_vendor
  ON public.inbound_shipments (business_id, vendor_id);

-- ---------- 2. inbound_shipment_items -------------------------------
CREATE TABLE IF NOT EXISTS public.inbound_shipment_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  business_id uuid NOT NULL,
  branch_id uuid,
  shipment_id uuid NOT NULL REFERENCES public.inbound_shipments(id) ON DELETE CASCADE,
  purchase_order_item_id uuid REFERENCES public.purchase_order_items(id) ON DELETE SET NULL,
  product_id uuid NOT NULL REFERENCES public.products(id) ON DELETE RESTRICT,
  expected_quantity numeric NOT NULL CHECK (expected_quantity >= 0),
  expected_lot_number text,
  expected_expiry_date date,
  expected_manufacture_date date,
  expected_packaging_id uuid REFERENCES public.product_packaging(id) ON DELETE SET NULL,
  display_uom_id uuid REFERENCES public.units_of_measure(id),
  display_quantity numeric,
  notes text,
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.inbound_shipment_items TO authenticated;
GRANT ALL ON public.inbound_shipment_items TO service_role;

ALTER TABLE public.inbound_shipment_items ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS inbound_shipment_items_select ON public.inbound_shipment_items;
CREATE POLICY inbound_shipment_items_select ON public.inbound_shipment_items
  FOR SELECT TO authenticated
  USING (
    public.user_can_access_business(auth.uid(), business_id)
    AND (branch_id IS NULL OR public.can_access_branch(auth.uid(), branch_id))
  );

DROP POLICY IF EXISTS inbound_shipment_items_write ON public.inbound_shipment_items;
CREATE POLICY inbound_shipment_items_write ON public.inbound_shipment_items
  FOR ALL TO authenticated
  USING (
    public.user_can_access_business(auth.uid(), business_id)
    AND (branch_id IS NULL OR public.can_access_branch(auth.uid(), branch_id))
    AND public.user_has_module_permission(auth.uid(), business_id, 'inventory', 'write')
  )
  WITH CHECK (
    public.user_can_access_business(auth.uid(), business_id)
    AND (branch_id IS NULL OR public.can_access_branch(auth.uid(), branch_id))
    AND public.user_has_module_permission(auth.uid(), business_id, 'inventory', 'write')
  );

CREATE INDEX IF NOT EXISTS idx_inbound_shipment_items_shipment
  ON public.inbound_shipment_items (shipment_id);
CREATE INDEX IF NOT EXISTS idx_inbound_shipment_items_product
  ON public.inbound_shipment_items (business_id, product_id);
CREATE INDEX IF NOT EXISTS idx_inbound_shipment_items_po_item
  ON public.inbound_shipment_items (purchase_order_item_id) WHERE purchase_order_item_id IS NOT NULL;

-- ---------- 3. goods_receipt_discrepancies --------------------------
CREATE TABLE IF NOT EXISTS public.goods_receipt_discrepancies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  business_id uuid NOT NULL,
  branch_id uuid,
  goods_receipt_id uuid NOT NULL REFERENCES public.goods_receipts(id) ON DELETE CASCADE,
  goods_receipt_item_id uuid REFERENCES public.goods_receipt_items(id) ON DELETE SET NULL,
  inbound_shipment_item_id uuid REFERENCES public.inbound_shipment_items(id) ON DELETE SET NULL,
  product_id uuid NOT NULL REFERENCES public.products(id) ON DELETE RESTRICT,
  discrepancy_type public.goods_receipt_discrepancy_type NOT NULL,
  expected_quantity numeric NOT NULL CHECK (expected_quantity >= 0),
  received_quantity numeric NOT NULL CHECK (received_quantity >= 0),
  resolution public.goods_receipt_discrepancy_resolution NOT NULL DEFAULT 'pending',
  resolved_at timestamptz,
  resolved_by uuid,
  notes text,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.goods_receipt_discrepancies TO authenticated;
GRANT ALL ON public.goods_receipt_discrepancies TO service_role;

ALTER TABLE public.goods_receipt_discrepancies ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS goods_receipt_discrepancies_select ON public.goods_receipt_discrepancies;
CREATE POLICY goods_receipt_discrepancies_select ON public.goods_receipt_discrepancies
  FOR SELECT TO authenticated
  USING (
    public.user_can_access_business(auth.uid(), business_id)
    AND (branch_id IS NULL OR public.can_access_branch(auth.uid(), branch_id))
  );

DROP POLICY IF EXISTS goods_receipt_discrepancies_write ON public.goods_receipt_discrepancies;
CREATE POLICY goods_receipt_discrepancies_write ON public.goods_receipt_discrepancies
  FOR ALL TO authenticated
  USING (
    public.user_can_access_business(auth.uid(), business_id)
    AND (branch_id IS NULL OR public.can_access_branch(auth.uid(), branch_id))
    AND public.user_has_module_permission(auth.uid(), business_id, 'inventory', 'write')
  )
  WITH CHECK (
    public.user_can_access_business(auth.uid(), business_id)
    AND (branch_id IS NULL OR public.can_access_branch(auth.uid(), branch_id))
    AND public.user_has_module_permission(auth.uid(), business_id, 'inventory', 'write')
  );

CREATE INDEX IF NOT EXISTS idx_grn_discrepancies_receipt
  ON public.goods_receipt_discrepancies (goods_receipt_id);
CREATE INDEX IF NOT EXISTS idx_grn_discrepancies_shipment_item
  ON public.goods_receipt_discrepancies (inbound_shipment_item_id) WHERE inbound_shipment_item_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_grn_discrepancies_biz_status
  ON public.goods_receipt_discrepancies (business_id, resolution);

-- ---------- updated_at triggers -------------------------------------
CREATE OR REPLACE FUNCTION public._set_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END $$;

DROP TRIGGER IF EXISTS trg_inbound_shipments_updated_at ON public.inbound_shipments;
CREATE TRIGGER trg_inbound_shipments_updated_at
  BEFORE UPDATE ON public.inbound_shipments
  FOR EACH ROW EXECUTE FUNCTION public._set_updated_at();

DROP TRIGGER IF EXISTS trg_inbound_shipment_items_updated_at ON public.inbound_shipment_items;
CREATE TRIGGER trg_inbound_shipment_items_updated_at
  BEFORE UPDATE ON public.inbound_shipment_items
  FOR EACH ROW EXECUTE FUNCTION public._set_updated_at();

DROP TRIGGER IF EXISTS trg_grn_discrepancies_updated_at ON public.goods_receipt_discrepancies;
CREATE TRIGGER trg_grn_discrepancies_updated_at
  BEFORE UPDATE ON public.goods_receipt_discrepancies
  FOR EACH ROW EXECUTE FUNCTION public._set_updated_at();

-- ---------- Table comments ------------------------------------------
COMMENT ON TABLE public.inbound_shipments IS
  'ADR-0069: Advance Shipping Notice header. One row per physical shipment '
  'between a vendor and a receiving warehouse.';
COMMENT ON TABLE public.inbound_shipment_items IS
  'ADR-0069: ASN detail. Vendor-declared expected quantity + lot/expiry per product.';
COMMENT ON TABLE public.goods_receipt_discrepancies IS
  'ADR-0069: normalised over/short/damaged/wrong-item ledger against a goods receipt.';
