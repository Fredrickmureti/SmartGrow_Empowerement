CREATE OR REPLACE FUNCTION public.rfq_portal_search_products(_invitation_id uuid, _query text DEFAULT NULL, _limit int DEFAULT 20)
RETURNS TABLE (id uuid, name text, sku text, base_uom_id uuid)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  inv public.rfq_invitations;
  v public.rfqs;
BEGIN
  SELECT * INTO inv FROM public.rfq_invitations WHERE rfq_invitations.id = _invitation_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Invitation not found'; END IF;
  SELECT * INTO v FROM public.rfqs WHERE rfqs.id = inv.rfq_id;

  IF NOT EXISTS (
    SELECT 1 FROM public.contacts c
     WHERE c.id = inv.supplier_id AND c.portal_user_id = auth.uid()
  ) AND NOT public.user_can_access_business(auth.uid(), v.business_id) THEN
    RAISE EXCEPTION 'Not authorised for this RFQ';
  END IF;

  IF inv.invitation_state IN ('withdrawn','superseded') THEN
    RAISE EXCEPTION 'This invitation is no longer active';
  END IF;

  RETURN QUERY
  SELECT p.id, p.name, p.sku, p.base_uom_id
    FROM public.products p
   WHERE p.organization_id = v.organization_id
     AND (v.business_id IS NULL OR p.business_id IS NULL OR p.business_id = v.business_id)
     AND p.is_active IS NOT FALSE
     AND (
       _query IS NULL OR btrim(_query) = ''
       OR p.name ILIKE '%' || btrim(_query) || '%'
       OR p.sku ILIKE '%' || btrim(_query) || '%'
     )
   ORDER BY p.name
   LIMIT GREATEST(1, LEAST(COALESCE(_limit, 20), 50));
END;
$$;

REVOKE ALL ON FUNCTION public.rfq_portal_search_products(uuid, text, int) FROM public;
GRANT EXECUTE ON FUNCTION public.rfq_portal_search_products(uuid, text, int) TO authenticated;