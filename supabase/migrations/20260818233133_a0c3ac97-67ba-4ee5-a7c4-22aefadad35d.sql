-- Orphan check first: any stock_lots row pointing at a missing receipt must be
-- cleared before the constraint can be trusted.
UPDATE public.stock_lots sl
   SET goods_receipt_id = NULL
 WHERE sl.goods_receipt_id IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM public.goods_receipts gr WHERE gr.id = sl.goods_receipt_id);

ALTER TABLE public.stock_lots
  ADD CONSTRAINT stock_lots_goods_receipt_id_fkey
  FOREIGN KEY (goods_receipt_id)
  REFERENCES public.goods_receipts(id)
  ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_stock_lots_goods_receipt_id
  ON public.stock_lots (goods_receipt_id)
  WHERE goods_receipt_id IS NOT NULL;