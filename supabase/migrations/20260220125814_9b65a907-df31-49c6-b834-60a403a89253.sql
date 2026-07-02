
-- First drop all three functions to allow return type changes if needed
DROP FUNCTION IF EXISTS public.get_next_journal_entry_number(uuid);
DROP FUNCTION IF EXISTS public.get_next_invoice_number(uuid);
DROP FUNCTION IF EXISTS public.get_next_bill_number(uuid);

-- Recreate with advisory locks instead of FOR UPDATE

CREATE FUNCTION public.get_next_journal_entry_number(_org_id uuid)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  next_num bigint;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('journal_entries_' || _org_id::text));
  
  SELECT COALESCE(MAX(entry_number), 0) + 1
  INTO next_num
  FROM public.journal_entries
  WHERE organization_id = _org_id;
  
  RETURN next_num;
END;
$$;

CREATE FUNCTION public.get_next_invoice_number(_org_id uuid)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  next_num integer;
  prefix text;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('invoices_' || _org_id::text));
  
  SELECT COALESCE(MAX(
    CASE WHEN invoice_number ~ '\d+$'
      THEN CAST(substring(invoice_number FROM '\d+$') AS integer)
      ELSE 0
    END
  ), 0) + 1
  INTO next_num
  FROM public.invoices
  WHERE organization_id = _org_id;
  
  SELECT COALESCE(b.invoice_prefix, 'INV-')
  INTO prefix
  FROM public.businesses b
  WHERE b.organization_id = _org_id
  LIMIT 1;
  
  prefix := COALESCE(prefix, 'INV-');
  
  RETURN prefix || LPAD(next_num::text, 5, '0');
END;
$$;

CREATE FUNCTION public.get_next_bill_number(_org_id uuid)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  next_num integer;
  prefix text;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('bills_' || _org_id::text));
  
  SELECT COALESCE(MAX(
    CASE WHEN bill_number ~ '\d+$'
      THEN CAST(substring(bill_number FROM '\d+$') AS integer)
      ELSE 0
    END
  ), 0) + 1
  INTO next_num
  FROM public.bills
  WHERE organization_id = _org_id;
  
  SELECT COALESCE(b.bill_prefix, 'BILL-')
  INTO prefix
  FROM public.businesses b
  WHERE b.organization_id = _org_id
  LIMIT 1;
  
  prefix := COALESCE(prefix, 'BILL-');
  
  RETURN prefix || LPAD(next_num::text, 5, '0');
END;
$$;
