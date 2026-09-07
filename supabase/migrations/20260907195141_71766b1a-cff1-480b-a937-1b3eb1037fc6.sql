DROP TRIGGER IF EXISTS trg_wms_backlink_return_credit_note ON public.credit_notes;
DROP FUNCTION IF EXISTS public._wms_backlink_return_credit_note() CASCADE;
ALTER TABLE public.credit_notes DROP COLUMN IF EXISTS source_return_id CASCADE;
DROP TABLE IF EXISTS public.sales_return_cost_allocations CASCADE;
DROP TABLE IF EXISTS public.sales_return_cost_basis CASCADE;
DROP TABLE IF EXISTS public.sales_return_items CASCADE;
DROP TABLE IF EXISTS public.sales_returns CASCADE;