CREATE OR REPLACE FUNCTION public.mf_method_mapping_key(p_method text)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path TO 'public'
AS $$
  SELECT CASE p_method
    WHEN 'cash' THEN 'cash'
    WHEN 'bank_transfer' THEN 'bank'
    WHEN 'cheque' THEN 'bank'
    WHEN 'mobile_money' THEN 'mobile_money'
    ELSE NULL END;
$$;