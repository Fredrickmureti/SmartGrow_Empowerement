DROP TRIGGER IF EXISTS trg_pos_transaction_post_sale_gl ON public.pos_transactions;

CREATE CONSTRAINT TRIGGER trg_pos_transaction_post_sale_gl
AFTER INSERT ON public.pos_transactions
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION public.trg_pos_transaction_post_sale_gl_fn();