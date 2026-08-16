CREATE OR REPLACE FUNCTION public.get_next_po_number(_org_id uuid)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  next_num    integer;
  year_prefix text := to_char(CURRENT_DATE, 'YYYY');
BEGIN
  -- Serialise number generation for this org; the uniqueness constraint on
  -- po_number is org-wide, so the lock must be too.
  PERFORM pg_advisory_xact_lock(hashtext('purchase_orders_' || _org_id::text));

  -- Parse ONLY the trailing counter segment, never the whole string
  -- (stripping all non-digits would fold the year into the counter).
  SELECT COALESCE(MAX(
           CAST(NULLIF(regexp_replace(split_part(po_number, '-', 3), '[^0-9]', '', 'g'), '') AS integer)
         ), 0) + 1
    INTO next_num
    FROM public.purchase_orders
   WHERE organization_id = _org_id
     AND po_number LIKE 'PO-' || year_prefix || '-%';

  RETURN 'PO-' || year_prefix || '-' || LPAD(next_num::text, 4, '0');
END;
$$;