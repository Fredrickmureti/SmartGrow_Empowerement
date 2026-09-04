ALTER TABLE public.delivery_notes DROP COLUMN IF EXISTS carrier_id;
DROP TABLE IF EXISTS public.sales_return_cost_allocations CASCADE;
DROP TABLE IF EXISTS public.cost_layer_lineage CASCADE;
DROP TABLE IF EXISTS public.cost_layer_consumptions CASCADE;
DROP TABLE IF EXISTS public.cost_layers CASCADE;
DROP TABLE IF EXISTS public.backorders CASCADE;
DROP TABLE IF EXISTS public.carriers CASCADE;