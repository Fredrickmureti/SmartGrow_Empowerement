DROP TRIGGER IF EXISTS trg_zz_pricing_normalize_credit_note_items ON public.credit_note_items;
DROP TRIGGER IF EXISTS trg_zz_pricing_normalize_estimate_items ON public.estimate_items;
DROP TRIGGER IF EXISTS trg_zz_pricing_normalize_invoice_items ON public.invoice_items;
DROP TRIGGER IF EXISTS trg_zz_pricing_normalize_proforma_items ON public.proforma_invoice_items;
DROP TRIGGER IF EXISTS trg_zz_pricing_normalize_sales_order_items ON public.sales_order_items;

DROP FUNCTION IF EXISTS public._pricing_normalize_line();
DROP FUNCTION IF EXISTS public.pos_resolve_line(uuid, uuid, uuid, uuid, numeric);
DROP FUNCTION IF EXISTS public.resolve_line_unit_price(uuid, uuid, uuid, uuid, uuid, numeric);

ALTER TABLE public.contacts DROP COLUMN IF EXISTS customer_group_id;
ALTER TABLE public.contacts DROP COLUMN IF EXISTS price_list_id;

DROP TABLE IF EXISTS public.price_list_items;
DROP TABLE IF EXISTS public.price_lists;
DROP TABLE IF EXISTS public.customer_groups;