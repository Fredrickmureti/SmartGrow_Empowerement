-- ADR 0027 Batch 2 — make append-only reallocation actually work.
--
-- `reallocate_payment_atomic` inserts negative compensating allocation
-- rows ("append-only" reversal: never UPDATE/DELETE an old row, instead
-- post a negative of it and then post the new state). Today that INSERT
-- fails because `payment_allocations_amount_check` requires amount > 0,
-- so the RPC is a latent time bomb.
--
-- Relax the check to `amount <> 0`. The DEFERRABLE sum-invariant trigger
-- (`trg_payment_alloc_sum_invariant`) still ensures the SUM matches
-- `payments.applied_amount` at commit time, so this does not weaken
-- invariants — it only permits the compensating rows the append-only
-- contract requires. Application code paths that build a new allocation
-- still validate amount > 0 inside `reallocate_payment_atomic` and
-- `record_multi_invoice_payment`; only the internal compensating insert
-- is allowed to be negative.

ALTER TABLE public.payment_allocations
  DROP CONSTRAINT IF EXISTS payment_allocations_amount_check;

ALTER TABLE public.payment_allocations
  ADD CONSTRAINT payment_allocations_amount_nonzero
  CHECK (amount <> 0);

COMMENT ON CONSTRAINT payment_allocations_amount_nonzero
  ON public.payment_allocations IS
  'ADR 0027: allocation amounts may be negative when emitted by '
  'reallocate_payment_atomic as compensating rows. Application-level '
  'inserts (record_multi_invoice_payment, record_payment_atomic, '
  'migration backfill) still validate amount > 0 in the RPC body.';