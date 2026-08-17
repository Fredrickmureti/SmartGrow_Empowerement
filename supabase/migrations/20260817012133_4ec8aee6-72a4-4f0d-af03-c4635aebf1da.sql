-- INV-SIM Repair #2: consume_stock_reservation() zeroes `quantity` when a
-- reservation is fully consumed, which the old CHECK (quantity > 0) rejected.
-- Every full consumption (replenishment completion, POS, sales orders) failed
-- with 23514. Keep positivity where it matters — reservations that are still
-- open — and allow closed rows to settle at zero.
ALTER TABLE public.stock_reservations
  DROP CONSTRAINT IF EXISTS stock_reservations_quantity_check;

ALTER TABLE public.stock_reservations
  ADD CONSTRAINT stock_reservations_quantity_check
  CHECK (
    quantity >= 0
    AND (status NOT IN ('reserved','allocated') OR quantity > 0)
  );

COMMENT ON CONSTRAINT stock_reservations_quantity_check ON public.stock_reservations IS
  'Open reservations (reserved/allocated) must hold a positive quantity; consumed/released/expired rows settle at zero (see consume_stock_reservation).';