ALTER TABLE public.invoice_items DROP COLUMN IF EXISTS delivery_note_item_id CASCADE;
ALTER TABLE public.invoices DROP COLUMN IF EXISTS source_delivery_note_id CASCADE;
ALTER TABLE public.wms_loading_manifests DROP COLUMN IF EXISTS delivery_note_id CASCADE;
DROP TABLE IF EXISTS public.delivery_proofs CASCADE;
DROP TABLE IF EXISTS public.delivery_note_events CASCADE;
DROP TABLE IF EXISTS public.delivery_note_items CASCADE;
DROP TABLE IF EXISTS public.delivery_notes CASCADE;