
-- Step 1: Add vendor acknowledgment columns to purchase_orders
ALTER TABLE public.purchase_orders
ADD COLUMN IF NOT EXISTS vendor_confirmed_at timestamptz,
ADD COLUMN IF NOT EXISTS vendor_notes text;

-- Step 2: RLS policy for vendors to SELECT purchase_order_items
CREATE POLICY "Vendor portal users can view their PO items"
ON public.purchase_order_items FOR SELECT
USING (purchase_order_id IN (
  SELECT id FROM public.purchase_orders
  WHERE vendor_id IN (
    SELECT id FROM public.contacts WHERE portal_user_id = auth.uid()
  )
));

-- Step 3: RLS policy for vendors to SELECT their linked organization
CREATE POLICY "Vendor portal users can view their linked organization"
ON public.organizations FOR SELECT
USING (id IN (
  SELECT organization_id FROM public.contacts WHERE portal_user_id = auth.uid()
));

-- Step 4: RLS policy for vendors to UPDATE their own contact record
CREATE POLICY "Vendor portal users can update own contact"
ON public.contacts FOR UPDATE
USING (portal_user_id = auth.uid())
WITH CHECK (portal_user_id = auth.uid());

-- Step 5: RLS policy for vendors to UPDATE purchase_orders (acknowledge only)
CREATE POLICY "Vendor portal users can acknowledge their POs"
ON public.purchase_orders FOR UPDATE
USING (vendor_id IN (
  SELECT id FROM public.contacts WHERE portal_user_id = auth.uid()
))
WITH CHECK (vendor_id IN (
  SELECT id FROM public.contacts WHERE portal_user_id = auth.uid()
));
