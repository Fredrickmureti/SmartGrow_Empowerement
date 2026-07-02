
-- Reversal: goods_receipts.received_by was already uuid REFERENCES auth.users(id).
-- The previous backfill incorrectly moved its values into a new duplicate
-- column. Restore and drop the duplicate.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name='goods_receipts'
       AND column_name='received_by_user_id'
  ) THEN
    EXECUTE 'UPDATE public.goods_receipts
                SET received_by = received_by_user_id
              WHERE received_by IS NULL AND received_by_user_id IS NOT NULL';
    EXECUTE 'DROP INDEX IF EXISTS public.idx_goods_receipts_received_by_user_id';
    EXECUTE 'ALTER TABLE public.goods_receipts DROP COLUMN received_by_user_id';
  END IF;
END $$;
