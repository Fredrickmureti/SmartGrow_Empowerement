-- Canonical UoM engine fix: converting an absent quantity is a no-op, not an
-- error. Previously convert_uom(NULL, NULL, kg) raised "unknown UoM", which
-- made enforce_physical_attribute_integrity() fail whenever a product had a
-- net weight but no tare weight. Fixed at the canonical engine, not locally.
CREATE OR REPLACE FUNCTION public.convert_uom(p_qty numeric, p_from_uom uuid, p_to_uom uuid)
 RETURNS numeric
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  f_factor numeric; t_factor numeric;
  f_cat uuid; t_cat uuid; t_round numeric;
BEGIN
  -- Nothing to convert: absence of a measurement is a legitimate NULL and must
  -- not be confused with an unknown unit of measure.
  IF p_qty IS NULL THEN RETURN NULL; END IF;
  IF p_from_uom = p_to_uom THEN RETURN p_qty; END IF;
  SELECT factor_to_reference, category_id INTO f_factor, f_cat
    FROM public.units_of_measure WHERE id = p_from_uom;
  SELECT factor_to_reference, category_id, rounding INTO t_factor, t_cat, t_round
    FROM public.units_of_measure WHERE id = p_to_uom;
  IF f_factor IS NULL OR t_factor IS NULL THEN
    RAISE EXCEPTION 'convert_uom: unknown UoM (from=%, to=%)', p_from_uom, p_to_uom;
  END IF;
  IF f_cat <> t_cat THEN
    RAISE EXCEPTION 'convert_uom: incompatible UoM categories';
  END IF;
  RETURN round((p_qty * f_factor / t_factor) / t_round) * t_round;
END $function$;