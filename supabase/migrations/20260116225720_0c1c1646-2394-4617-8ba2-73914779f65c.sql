-- Fix the get_next_pos_transaction_number function to avoid integer overflow
-- The issue: extracting ALL digits from "POS1-260115-0001" creates 12601150001 which exceeds INTEGER limit
-- The fix: only extract the sequence number (last part after final hyphen)

CREATE OR REPLACE FUNCTION public.get_next_pos_transaction_number(_org_id uuid, _register_code text)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
    next_num INTEGER;
    date_prefix TEXT;
BEGIN
    date_prefix := to_char(CURRENT_DATE, 'YYMMDD');
    
    -- Only extract the sequence number (third part after hyphen), not all digits
    -- Example: POS1-260115-0001 -> split by '-' -> get part 3 -> 0001 -> 1
    SELECT COALESCE(MAX(
        CAST(NULLIF(split_part(transaction_number, '-', 3), '') AS INTEGER)
    ), 0) + 1
    INTO next_num
    FROM public.pos_transactions
    WHERE organization_id = _org_id
    AND transaction_number LIKE _register_code || '-' || date_prefix || '-%';
    
    RETURN _register_code || '-' || date_prefix || '-' || LPAD(next_num::TEXT, 4, '0');
END;
$function$;