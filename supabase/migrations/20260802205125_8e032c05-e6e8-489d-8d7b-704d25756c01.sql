-- Receiving line grain must resolve its product for display (name/SKU embeds).
DELETE FROM public.wms_receiving_lines l
 WHERE l.product_id IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM public.products p WHERE p.id = l.product_id);

ALTER TABLE public.wms_receiving_lines
  ADD CONSTRAINT wms_receiving_lines_product_id_fkey
  FOREIGN KEY (product_id) REFERENCES public.products(id) ON DELETE RESTRICT;
