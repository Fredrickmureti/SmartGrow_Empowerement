CREATE OR REPLACE FUNCTION public.get_next_requisition_number(_org_id uuid, _business_id uuid)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_next int;
  v_year text := to_char(CURRENT_DATE, 'YYYY');
BEGIN
  PERFORM pg_advisory_xact_lock(
    hashtext('purchase_requisitions_' || _org_id::text || '_' || COALESCE(_business_id::text, 'global'))
  );

  -- Parse ONLY the trailing counter segment, never the whole string.
  SELECT COALESCE(MAX(
           CAST(NULLIF(regexp_replace(split_part(requisition_number, '-', 3), '[^0-9]', '', 'g'), '') AS INTEGER)
         ), 0) + 1
    INTO v_next
    FROM public.purchase_requisitions
   WHERE organization_id = _org_id
     AND business_id = _business_id
     AND requisition_number LIKE 'PR-' || v_year || '-%';

  RETURN 'PR-' || v_year || '-' || LPAD(v_next::text, 4, '0');
END;
$$;