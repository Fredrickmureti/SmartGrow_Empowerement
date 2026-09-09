CREATE OR REPLACE FUNCTION public.mf_next_fee_receipt_number(
  p_business_id uuid,
  p_on date,
  p_attempt integer DEFAULT 1
) RETURNS text
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_prefix text := 'ADM-' || to_char(COALESCE(p_on, CURRENT_DATE), 'YYYYMM') || '-';
  v_seq bigint;
BEGIN
  SELECT COALESCE(MAX(n), 0) + GREATEST(p_attempt, 1) INTO v_seq
  FROM (
    SELECT NULLIF(regexp_replace(right(receipt_number, 5), '\D', '', 'g'), '')::bigint AS n
      FROM public.mf_client_charges
     WHERE business_id = p_business_id AND receipt_number LIKE v_prefix || '%'
    UNION ALL
    SELECT NULLIF(regexp_replace(right(receipt_number, 5), '\D', '', 'g'), '')::bigint
      FROM public.mf_client_charge_payments
     WHERE business_id = p_business_id AND receipt_number LIKE v_prefix || '%'
  ) s;
  RETURN v_prefix || lpad(v_seq::text, 5, '0');
END;
$function$;

REVOKE ALL ON FUNCTION public.mf_next_fee_receipt_number(uuid, date, integer) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.mf_next_fee_collection_number(
  p_business_id uuid,
  p_on date,
  p_attempt integer DEFAULT 1
) RETURNS text
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_prefix text := 'GFC-' || to_char(COALESCE(p_on, CURRENT_DATE), 'YYYYMM') || '-';
  v_seq bigint;
BEGIN
  SELECT COALESCE(MAX(NULLIF(regexp_replace(right(collection_number, 5), '\D', '', 'g'), '')::bigint), 0)
         + GREATEST(p_attempt, 1)
    INTO v_seq
    FROM public.mf_fee_collections
   WHERE business_id = p_business_id AND collection_number LIKE v_prefix || '%';
  RETURN v_prefix || lpad(v_seq::text, 5, '0');
END;
$function$;

REVOKE ALL ON FUNCTION public.mf_next_fee_collection_number(uuid, date, integer) FROM PUBLIC, anon, authenticated;