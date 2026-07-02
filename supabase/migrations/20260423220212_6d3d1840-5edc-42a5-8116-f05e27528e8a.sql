
-- ============================================================
-- PHASE 1 — CRITICAL SECURITY FIXES (Contacts module audit)
-- R1: contact_addresses RLS — close cross-company leak (C1)
-- R2: vendor_pricelists RLS — close cross-company leak (C2)
-- R3: customer_loyalty — add business_id + business-scoped RLS (C3)
-- R4: vendor portal self-update — restrict via security-definer RPC (C6)
-- R5: vendor_id NOT NULL on procurement tables (H8)
-- ============================================================

-- ─── R1. contact_addresses ──────────────────────────────────
DROP POLICY IF EXISTS "Users can manage contact addresses in their org" ON public.contact_addresses;

CREATE POLICY "contact_addresses_select_v2"
ON public.contact_addresses
FOR SELECT
USING (
  user_can_access_business(auth.uid(), business_id)
  AND user_has_module_permission(auth.uid(), organization_id, business_id, 'contacts', 'read')
);

CREATE POLICY "contact_addresses_insert_v2"
ON public.contact_addresses
FOR INSERT
WITH CHECK (
  user_can_access_business(auth.uid(), business_id)
  AND user_has_module_permission(auth.uid(), organization_id, business_id, 'contacts', 'create')
);

CREATE POLICY "contact_addresses_update_v2"
ON public.contact_addresses
FOR UPDATE
USING (
  user_can_access_business(auth.uid(), business_id)
  AND user_has_module_permission(auth.uid(), organization_id, business_id, 'contacts', 'write')
)
WITH CHECK (
  user_can_access_business(auth.uid(), business_id)
  AND user_has_module_permission(auth.uid(), organization_id, business_id, 'contacts', 'write')
);

CREATE POLICY "contact_addresses_delete_v2"
ON public.contact_addresses
FOR DELETE
USING (
  user_can_access_business(auth.uid(), business_id)
  AND user_has_module_permission(auth.uid(), organization_id, business_id, 'contacts', 'delete')
);

-- ─── R2. vendor_pricelists ──────────────────────────────────
DROP POLICY IF EXISTS "vendor_pricelists_select" ON public.vendor_pricelists;
DROP POLICY IF EXISTS "vendor_pricelists_insert" ON public.vendor_pricelists;
DROP POLICY IF EXISTS "vendor_pricelists_update" ON public.vendor_pricelists;
DROP POLICY IF EXISTS "vendor_pricelists_delete" ON public.vendor_pricelists;
-- keep "Vendor portal users can view their price lists" — it is correct (restricts to own vendor).

CREATE POLICY "vendor_pricelists_select_v2"
ON public.vendor_pricelists
FOR SELECT
USING (
  user_can_access_business(auth.uid(), business_id)
  AND user_has_module_permission(auth.uid(), organization_id, business_id, 'purchases', 'read')
);

CREATE POLICY "vendor_pricelists_insert_v2"
ON public.vendor_pricelists
FOR INSERT
WITH CHECK (
  user_can_access_business(auth.uid(), business_id)
  AND user_has_module_permission(auth.uid(), organization_id, business_id, 'purchases', 'create')
);

CREATE POLICY "vendor_pricelists_update_v2"
ON public.vendor_pricelists
FOR UPDATE
USING (
  user_can_access_business(auth.uid(), business_id)
  AND user_has_module_permission(auth.uid(), organization_id, business_id, 'purchases', 'write')
)
WITH CHECK (
  user_can_access_business(auth.uid(), business_id)
  AND user_has_module_permission(auth.uid(), organization_id, business_id, 'purchases', 'write')
);

CREATE POLICY "vendor_pricelists_delete_v2"
ON public.vendor_pricelists
FOR DELETE
USING (
  user_can_access_business(auth.uid(), business_id)
  AND user_has_module_permission(auth.uid(), organization_id, business_id, 'purchases', 'delete')
);

-- ─── R3. customer_loyalty business scoping ──────────────────
ALTER TABLE public.customer_loyalty
  ADD COLUMN IF NOT EXISTS business_id uuid,
  ADD COLUMN IF NOT EXISTS organization_id uuid;

-- Backfill from contacts (table is empty per audit, but safe to run)
UPDATE public.customer_loyalty cl
SET business_id = c.business_id,
    organization_id = c.organization_id
FROM public.contacts c
WHERE cl.contact_id = c.id
  AND (cl.business_id IS NULL OR cl.organization_id IS NULL);

ALTER TABLE public.customer_loyalty
  ALTER COLUMN business_id SET NOT NULL,
  ALTER COLUMN organization_id SET NOT NULL;

ALTER TABLE public.customer_loyalty
  ADD CONSTRAINT customer_loyalty_business_id_fkey
    FOREIGN KEY (business_id) REFERENCES public.businesses(id) ON DELETE CASCADE,
  ADD CONSTRAINT customer_loyalty_organization_id_fkey
    FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS idx_customer_loyalty_business_id ON public.customer_loyalty(business_id);

DROP POLICY IF EXISTS customer_loyalty_select_perm ON public.customer_loyalty;
DROP POLICY IF EXISTS customer_loyalty_insert_perm ON public.customer_loyalty;
DROP POLICY IF EXISTS customer_loyalty_update_perm ON public.customer_loyalty;

CREATE POLICY "customer_loyalty_select_v2"
ON public.customer_loyalty
FOR SELECT
USING (
  user_can_access_business(auth.uid(), business_id)
  AND user_has_module_permission(auth.uid(), organization_id, business_id, 'contacts', 'read')
);

CREATE POLICY "customer_loyalty_insert_v2"
ON public.customer_loyalty
FOR INSERT
WITH CHECK (
  user_can_access_business(auth.uid(), business_id)
  AND user_has_module_permission(auth.uid(), organization_id, business_id, 'contacts', 'create')
);

CREATE POLICY "customer_loyalty_update_v2"
ON public.customer_loyalty
FOR UPDATE
USING (
  user_can_access_business(auth.uid(), business_id)
  AND user_has_module_permission(auth.uid(), organization_id, business_id, 'contacts', 'write')
)
WITH CHECK (
  user_can_access_business(auth.uid(), business_id)
  AND user_has_module_permission(auth.uid(), organization_id, business_id, 'contacts', 'write')
);

CREATE POLICY "customer_loyalty_delete_v2"
ON public.customer_loyalty
FOR DELETE
USING (
  user_can_access_business(auth.uid(), business_id)
  AND user_has_module_permission(auth.uid(), organization_id, business_id, 'contacts', 'delete')
);

-- Trigger to auto-fill business_id/organization_id from contact when omitted
CREATE OR REPLACE FUNCTION public.customer_loyalty_inherit_scope()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.business_id IS NULL OR NEW.organization_id IS NULL THEN
    SELECT c.business_id, c.organization_id
      INTO NEW.business_id, NEW.organization_id
    FROM public.contacts c
    WHERE c.id = NEW.contact_id;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_customer_loyalty_inherit_scope ON public.customer_loyalty;
CREATE TRIGGER trg_customer_loyalty_inherit_scope
BEFORE INSERT ON public.customer_loyalty
FOR EACH ROW
EXECUTE FUNCTION public.customer_loyalty_inherit_scope();

-- ─── R4. Vendor portal self-update — restrict to safe columns ───
-- The over-broad policy lets a portal user mutate credit_limit, accounts, etc.
-- Replace with a security-definer RPC that only writes a safe subset.

DROP POLICY IF EXISTS "Vendor portal users can update own contact" ON public.contacts;

CREATE OR REPLACE FUNCTION public.update_portal_contact_self(
  p_name text DEFAULT NULL,
  p_email text DEFAULT NULL,
  p_phone text DEFAULT NULL,
  p_address_line1 text DEFAULT NULL,
  p_address_line2 text DEFAULT NULL,
  p_city text DEFAULT NULL,
  p_state text DEFAULT NULL,
  p_postal_code text DEFAULT NULL,
  p_country text DEFAULT NULL
)
RETURNS public.contacts
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row public.contacts;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  UPDATE public.contacts
  SET name           = COALESCE(p_name, name),
      email          = COALESCE(p_email, email),
      phone          = COALESCE(p_phone, phone),
      address_line1  = COALESCE(p_address_line1, address_line1),
      address_line2  = COALESCE(p_address_line2, address_line2),
      city           = COALESCE(p_city, city),
      state          = COALESCE(p_state, state),
      postal_code    = COALESCE(p_postal_code, postal_code),
      country        = COALESCE(p_country, country),
      updated_at     = now()
  WHERE portal_user_id = auth.uid()
  RETURNING * INTO v_row;

  IF v_row.id IS NULL THEN
    RAISE EXCEPTION 'No portal contact found for current user';
  END IF;

  RETURN v_row;
END;
$$;

REVOKE ALL ON FUNCTION public.update_portal_contact_self(text, text, text, text, text, text, text, text, text) FROM public;
GRANT EXECUTE ON FUNCTION public.update_portal_contact_self(text, text, text, text, text, text, text, text, text) TO authenticated;

-- ─── R5. NOT NULL on vendor_id (procurement tables) ─────────
ALTER TABLE public.bills                ALTER COLUMN vendor_id SET NOT NULL;
ALTER TABLE public.purchase_orders      ALTER COLUMN vendor_id SET NOT NULL;
ALTER TABLE public.vendor_credit_notes  ALTER COLUMN vendor_id SET NOT NULL;
ALTER TABLE public.purchase_returns     ALTER COLUMN vendor_id SET NOT NULL;
