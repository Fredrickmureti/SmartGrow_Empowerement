CREATE OR REPLACE FUNCTION public.get_next_delivery_number(_org_id uuid, _business_id uuid)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  year_prefix text := to_char(CURRENT_DATE, 'YYYY');
  next_num int;
  candidate text;
BEGIN
  -- Serialize allocation per organization. The number space is org-wide for the
  -- year: scoping the scan to a business made the sequence restart at 0001 for
  -- callers that pass a NULL business, colliding with the
  -- (organization_id, business_id, delivery_number) unique index.
  PERFORM pg_advisory_xact_lock(
    hashtextextended('dn_number:' || _org_id::text, 0)
  );

  SELECT COALESCE(MAX(NULLIF(regexp_replace(delivery_number, '^DN-\d{4}-', ''), '')::int), 0) + 1
    INTO next_num
  FROM public.delivery_notes
  WHERE organization_id = _org_id
    AND delivery_number ~ ('^DN-' || year_prefix || '-\d+$');

  -- Belt and braces: never hand back a number that already exists in the
  -- target scope, so a stale max can never surface as a 409 to the operator.
  LOOP
    candidate := 'DN-' || year_prefix || '-' || lpad(next_num::text, 4, '0');
    EXIT WHEN NOT EXISTS (
      SELECT 1 FROM public.delivery_notes
      WHERE organization_id = _org_id
        AND business_id IS NOT DISTINCT FROM _business_id
        AND delivery_number = candidate
    );
    next_num := next_num + 1;
  END LOOP;

  RETURN candidate;
END;
$$;