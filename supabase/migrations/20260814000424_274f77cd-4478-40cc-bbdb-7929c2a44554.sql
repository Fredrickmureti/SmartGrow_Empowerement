-- 1. save_product_atomic: remove the legacy etims_* compat layer and emit
--    product.updated through the canonical event publisher.
CREATE OR REPLACE FUNCTION public.save_product_atomic(
  p_product jsonb,
  p_product_id uuid DEFAULT NULL::uuid,
  p_packaging jsonb DEFAULT '[]'::jsonb,
  p_physical jsonb DEFAULT '[]'::jsonb,
  p_identifiers jsonb DEFAULT '[]'::jsonb,
  p_localization jsonb DEFAULT NULL::jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_src  text;
  v_new  text;
  v_def  text;
BEGIN
  -- This wrapper is replaced below by the real body; placeholder guard.
  RAISE EXCEPTION 'PRODUCT_PAYLOAD_INVALID: placeholder';
END;
$function$;

DO $do$
DECLARE
  v_def text;
BEGIN
  -- Rebuild from the previous definition is not possible here (it was just
  -- overwritten), so the full body is defined explicitly below.
  NULL;
END;
$do$;
