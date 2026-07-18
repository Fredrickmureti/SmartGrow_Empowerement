
-- 1. pos_stock_reservations compat view + soft-delete trigger.
DROP TRIGGER IF EXISTS trg_pos_stock_reservations_soft_delete ON public.pos_stock_reservations;
DROP VIEW IF EXISTS public.pos_stock_reservations;
DROP FUNCTION IF EXISTS public.tg_pos_stock_reservations_soft_delete();

-- 2. Shift-close aggregate GL poster and its wrappers.
--    Per-sale GL posting (post_pos_sale_gl via trg_pos_transaction_post_sale_gl)
--    handles revenue/COGS/tax/tender.  Cash variance is posted by the still-
--    active trg_pos_close_variance_gl trigger.  post_pos_shift_gl and its
--    replay/generate wrappers are no longer part of the transaction engine.
DROP FUNCTION IF EXISTS public.replay_pos_shift_gl(uuid);
DROP FUNCTION IF EXISTS public.generate_pos_shift_journal_entry() CASCADE;
DROP FUNCTION IF EXISTS public.trg_pos_shift_close_journal_fn() CASCADE;
DROP FUNCTION IF EXISTS public.post_pos_shift_gl(uuid);
