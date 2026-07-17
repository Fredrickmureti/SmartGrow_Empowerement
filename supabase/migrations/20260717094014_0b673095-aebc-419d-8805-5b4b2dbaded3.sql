
-- Blocking Gap #2 (Inventory Foundation Audit §6): true 3-way match + landed-cost distribution.
-- ADR 0077 accompanies this migration.

-- 1. Direct link on the bill header (optional; many bills cover multiple receipts).
ALTER TABLE public.bills
  ADD COLUMN IF NOT EXISTS goods_receipt_id uuid
    REFERENCES public.goods_receipts(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS bills_goods_receipt_id_idx
  ON public.bills(goods_receipt_id) WHERE goods_receipt_id IS NOT NULL;

-- 2. Line-level 3-way match junction.
CREATE TABLE IF NOT EXISTS public.bill_grn_matches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  business_id uuid NOT NULL,
  bill_id uuid NOT NULL REFERENCES public.bills(id) ON DELETE CASCADE,
  bill_item_id uuid NOT NULL REFERENCES public.bill_items(id) ON DELETE CASCADE,
  goods_receipt_id uuid NOT NULL REFERENCES public.goods_receipts(id) ON DELETE RESTRICT,
  goods_receipt_item_id uuid NOT NULL REFERENCES public.goods_receipt_items(id) ON DELETE RESTRICT,
  matched_quantity numeric(18,4) NOT NULL CHECK (matched_quantity > 0),
  unit_cost_variance numeric(18,4) DEFAULT 0,
  notes text,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (bill_item_id, goods_receipt_item_id)
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.bill_grn_matches TO authenticated;
GRANT ALL ON public.bill_grn_matches TO service_role;

ALTER TABLE public.bill_grn_matches ENABLE ROW LEVEL SECURITY;

CREATE POLICY "bill_grn_matches_member_read" ON public.bill_grn_matches
  FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.user_business_access uba
    WHERE uba.user_id = auth.uid() AND uba.business_id = bill_grn_matches.business_id
  ));

CREATE POLICY "bill_grn_matches_member_write" ON public.bill_grn_matches
  FOR ALL TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.user_business_access uba
    WHERE uba.user_id = auth.uid() AND uba.business_id = bill_grn_matches.business_id
      AND uba.role IN ('owner','admin','accountant','staff')
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM public.user_business_access uba
    WHERE uba.user_id = auth.uid() AND uba.business_id = bill_grn_matches.business_id
      AND uba.role IN ('owner','admin','accountant','staff')
  ));

CREATE INDEX bill_grn_matches_bill_idx ON public.bill_grn_matches(bill_id);
CREATE INDEX bill_grn_matches_grn_idx ON public.bill_grn_matches(goods_receipt_id);

-- 3. Landed-cost bills: freight, duty, insurance that need to be pushed into inventory cost.
CREATE TABLE IF NOT EXISTS public.landed_cost_bills (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  business_id uuid NOT NULL,
  bill_id uuid REFERENCES public.bills(id) ON DELETE SET NULL,
  vendor_id uuid REFERENCES public.contacts(id) ON DELETE SET NULL,
  cost_type text NOT NULL CHECK (cost_type IN ('freight','duty','insurance','handling','brokerage','other')),
  description text,
  currency text NOT NULL DEFAULT 'USD',
  total_amount numeric(18,4) NOT NULL CHECK (total_amount >= 0),
  allocation_basis text NOT NULL DEFAULT 'value'
    CHECK (allocation_basis IN ('quantity','value','weight','manual')),
  status text NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft','allocated','posted','reversed')),
  posted_at timestamptz,
  posted_by uuid,
  notes text,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.landed_cost_bills TO authenticated;
GRANT ALL ON public.landed_cost_bills TO service_role;

ALTER TABLE public.landed_cost_bills ENABLE ROW LEVEL SECURITY;

CREATE POLICY "landed_cost_bills_member_read" ON public.landed_cost_bills
  FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.user_business_access uba
    WHERE uba.user_id = auth.uid() AND uba.business_id = landed_cost_bills.business_id
  ));

CREATE POLICY "landed_cost_bills_member_write" ON public.landed_cost_bills
  FOR ALL TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.user_business_access uba
    WHERE uba.user_id = auth.uid() AND uba.business_id = landed_cost_bills.business_id
      AND uba.role IN ('owner','admin','accountant','staff')
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM public.user_business_access uba
    WHERE uba.user_id = auth.uid() AND uba.business_id = landed_cost_bills.business_id
      AND uba.role IN ('owner','admin','accountant','staff')
  ));

CREATE INDEX landed_cost_bills_business_idx ON public.landed_cost_bills(business_id, status);

-- 4. Per-GRN-line allocations of a landed cost.
CREATE TABLE IF NOT EXISTS public.landed_cost_allocations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  business_id uuid NOT NULL,
  landed_cost_bill_id uuid NOT NULL REFERENCES public.landed_cost_bills(id) ON DELETE CASCADE,
  goods_receipt_id uuid NOT NULL REFERENCES public.goods_receipts(id) ON DELETE RESTRICT,
  goods_receipt_item_id uuid NOT NULL REFERENCES public.goods_receipt_items(id) ON DELETE RESTRICT,
  product_id uuid REFERENCES public.products(id) ON DELETE SET NULL,
  basis_value numeric(18,4) NOT NULL DEFAULT 0,
  allocation_ratio numeric(18,8) NOT NULL DEFAULT 0 CHECK (allocation_ratio >= 0 AND allocation_ratio <= 1),
  allocated_amount numeric(18,4) NOT NULL DEFAULT 0,
  posted_movement_id uuid REFERENCES public.stock_movements(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (landed_cost_bill_id, goods_receipt_item_id)
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.landed_cost_allocations TO authenticated;
GRANT ALL ON public.landed_cost_allocations TO service_role;

ALTER TABLE public.landed_cost_allocations ENABLE ROW LEVEL SECURITY;

CREATE POLICY "landed_cost_allocations_member_read" ON public.landed_cost_allocations
  FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.user_business_access uba
    WHERE uba.user_id = auth.uid() AND uba.business_id = landed_cost_allocations.business_id
  ));

CREATE POLICY "landed_cost_allocations_member_write" ON public.landed_cost_allocations
  FOR ALL TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.user_business_access uba
    WHERE uba.user_id = auth.uid() AND uba.business_id = landed_cost_allocations.business_id
      AND uba.role IN ('owner','admin','accountant','staff')
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM public.user_business_access uba
    WHERE uba.user_id = auth.uid() AND uba.business_id = landed_cost_allocations.business_id
      AND uba.role IN ('owner','admin','accountant','staff')
  ));

CREATE INDEX landed_cost_allocations_bill_idx ON public.landed_cost_allocations(landed_cost_bill_id);
CREATE INDEX landed_cost_allocations_grn_idx ON public.landed_cost_allocations(goods_receipt_id);

-- 5. touch triggers
CREATE OR REPLACE FUNCTION public._touch_updated_at()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$;

DROP TRIGGER IF EXISTS trg_bill_grn_matches_touch ON public.bill_grn_matches;
CREATE TRIGGER trg_bill_grn_matches_touch BEFORE UPDATE ON public.bill_grn_matches
  FOR EACH ROW EXECUTE FUNCTION public._touch_updated_at();

DROP TRIGGER IF EXISTS trg_landed_cost_bills_touch ON public.landed_cost_bills;
CREATE TRIGGER trg_landed_cost_bills_touch BEFORE UPDATE ON public.landed_cost_bills
  FOR EACH ROW EXECUTE FUNCTION public._touch_updated_at();

DROP TRIGGER IF EXISTS trg_landed_cost_allocations_touch ON public.landed_cost_allocations;
CREATE TRIGGER trg_landed_cost_allocations_touch BEFORE UPDATE ON public.landed_cost_allocations
  FOR EACH ROW EXECUTE FUNCTION public._touch_updated_at();
