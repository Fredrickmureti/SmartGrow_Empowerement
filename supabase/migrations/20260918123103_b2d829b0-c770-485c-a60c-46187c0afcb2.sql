CREATE OR REPLACE FUNCTION public.fa_create_asset(_business_id uuid, _asset jsonb, _payment_method text DEFAULT 'bank', _settlement_account_id uuid DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_src text;
BEGIN
  -- placeholder, replaced below
  RETURN NULL;
END;
$fn$;
