
-- =====================================================================
-- MIGRATION 1: Purchases schema hardening (additive only)
-- =====================================================================

ALTER TABLE public.purchase_returns
  ADD COLUMN IF NOT EXISTS branch_id uuid REFERENCES public.branches(id);
CREATE INDEX IF NOT EXISTS idx_purchase_returns_branch_id ON public.purchase_returns(branch_id);

ALTER TABLE public.rfqs
  ADD COLUMN IF NOT EXISTS branch_id uuid REFERENCES public.branches(id);
CREATE INDEX IF NOT EXISTS idx_rfqs_branch_id ON public.rfqs(branch_id);

ALTER TABLE public.purchase_orders
  ADD COLUMN IF NOT EXISTS billing_status text NOT NULL DEFAULT 'no';
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='purchase_orders_billing_status_chk') THEN
    ALTER TABLE public.purchase_orders
      ADD CONSTRAINT purchase_orders_billing_status_chk
      CHECK (billing_status IN ('no','to_bill','fully_billed'));
  END IF;
END$$;
CREATE INDEX IF NOT EXISTS idx_purchase_orders_billing_status ON public.purchase_orders(billing_status);

ALTER TABLE public.purchase_order_items
  ADD COLUMN IF NOT EXISTS quantity_billed numeric NOT NULL DEFAULT 0;

-- Backfills
UPDATE public.purchase_orders
SET billing_status = 'fully_billed'
WHERE converted_bill_id IS NOT NULL AND billing_status = 'no';

UPDATE public.purchase_orders
SET billing_status = 'to_bill'
WHERE billing_status = 'no'
  AND converted_bill_id IS NULL
  AND status::text IN ('confirmed','partial_received','received');

UPDATE public.purchase_order_items poi
SET quantity_billed = poi.quantity
FROM public.purchase_orders po
WHERE poi.purchase_order_id = po.id
  AND po.billing_status = 'fully_billed'
  AND poi.quantity_billed = 0;

UPDATE public.purchase_returns pr
SET branch_id = b.branch_id
FROM public.bills b
WHERE pr.branch_id IS NULL
  AND pr.bill_id = b.id
  AND b.branch_id IS NOT NULL;

-- Vendor ↔ business match triggers
CREATE OR REPLACE FUNCTION public.enforce_po_vendor_business_match()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $fn$
DECLARE v_biz uuid; v_org uuid;
BEGIN
  IF NEW.vendor_id IS NULL THEN RETURN NEW; END IF;
  SELECT business_id, organization_id INTO v_biz, v_org FROM public.contacts WHERE id = NEW.vendor_id;
  IF v_org IS DISTINCT FROM NEW.organization_id THEN
    RAISE EXCEPTION 'vendor.organization_id (%) must match purchase_order.organization_id (%)', v_org, NEW.organization_id USING ERRCODE='check_violation';
  END IF;
  IF NEW.business_id IS NOT NULL AND v_biz IS DISTINCT FROM NEW.business_id THEN
    RAISE EXCEPTION 'vendor.business_id (%) must match purchase_order.business_id (%)', v_biz, NEW.business_id USING ERRCODE='check_violation';
  END IF;
  RETURN NEW;
END$fn$;
DROP TRIGGER IF EXISTS trg_enforce_po_vendor_business_match ON public.purchase_orders;
CREATE TRIGGER trg_enforce_po_vendor_business_match
  BEFORE INSERT OR UPDATE OF vendor_id, business_id, organization_id ON public.purchase_orders
  FOR EACH ROW EXECUTE FUNCTION public.enforce_po_vendor_business_match();

CREATE OR REPLACE FUNCTION public.enforce_vcn_vendor_business_match()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $fn$
DECLARE v_biz uuid; v_org uuid;
BEGIN
  IF NEW.vendor_id IS NULL THEN RETURN NEW; END IF;
  SELECT business_id, organization_id INTO v_biz, v_org FROM public.contacts WHERE id = NEW.vendor_id;
  IF v_org IS DISTINCT FROM NEW.organization_id THEN
    RAISE EXCEPTION 'vendor.organization_id (%) must match vendor_credit_note.organization_id (%)', v_org, NEW.organization_id USING ERRCODE='check_violation';
  END IF;
  IF NEW.business_id IS NOT NULL AND v_biz IS DISTINCT FROM NEW.business_id THEN
    RAISE EXCEPTION 'vendor.business_id (%) must match vendor_credit_note.business_id (%)', v_biz, NEW.business_id USING ERRCODE='check_violation';
  END IF;
  RETURN NEW;
END$fn$;
DROP TRIGGER IF EXISTS trg_enforce_vcn_vendor_business_match ON public.vendor_credit_notes;
CREATE TRIGGER trg_enforce_vcn_vendor_business_match
  BEFORE INSERT OR UPDATE OF vendor_id, business_id, organization_id ON public.vendor_credit_notes
  FOR EACH ROW EXECUTE FUNCTION public.enforce_vcn_vendor_business_match();

-- Goods Receipts RLS — promote v1 → v2
DROP POLICY IF EXISTS "Users can view goods receipts in their org"   ON public.goods_receipts;
DROP POLICY IF EXISTS "Users can create goods receipts in their org" ON public.goods_receipts;
DROP POLICY IF EXISTS "Users can update goods receipts in their org" ON public.goods_receipts;
DROP POLICY IF EXISTS "Users can delete goods receipts in their org" ON public.goods_receipts;

CREATE POLICY "Users view goods receipts in their business"
  ON public.goods_receipts FOR SELECT
  USING (
    public.user_can_access_business(auth.uid(), business_id)
    AND public.user_has_module_permission(auth.uid(), organization_id, 'purchases', 'viewer')
  );

CREATE POLICY "Users create goods receipts in their business"
  ON public.goods_receipts FOR INSERT
  WITH CHECK (
    public.user_can_access_business(auth.uid(), business_id)
    AND public.user_has_module_permission(auth.uid(), organization_id, 'purchases', 'editor')
  );

CREATE POLICY "Users update goods receipts in their business"
  ON public.goods_receipts FOR UPDATE
  USING (
    public.user_can_access_business(auth.uid(), business_id)
    AND public.user_has_module_permission(auth.uid(), organization_id, 'purchases', 'editor')
  );

CREATE POLICY "Users delete goods receipts in their business"
  ON public.goods_receipts FOR DELETE
  USING (
    public.user_can_access_business(auth.uid(), business_id)
    AND public.user_has_module_permission(auth.uid(), organization_id, 'purchases', 'admin')
  );
