DROP FUNCTION IF EXISTS public.convert_uom(numeric, uuid, uuid) CASCADE;
DROP FUNCTION IF EXISTS public.enforce_line_uom_consistency() CASCADE;
DROP FUNCTION IF EXISTS public.enforce_product_uom_category() CASCADE;
DROP FUNCTION IF EXISTS public.resolve_line_base_quantity() CASCADE;
DROP FUNCTION IF EXISTS public.tg_default_product_uom() CASCADE;

DROP TABLE IF EXISTS public.units_of_measure CASCADE;