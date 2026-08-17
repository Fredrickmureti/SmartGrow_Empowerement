-- INV-SIM Repair #1: stock_reservations rejected the two WMS source types
-- that live code actually writes ('replenishment' from _wms_replen_reserve,
-- 'pick_wave' from release_pick_wave). Auto-dispatch replenishment was
-- therefore 100% broken (23514 on every planned face).
ALTER TABLE public.stock_reservations
  DROP CONSTRAINT IF EXISTS stock_reservations_source_type_check;

ALTER TABLE public.stock_reservations
  ADD CONSTRAINT stock_reservations_source_type_check
  CHECK (source_type = ANY (ARRAY[
    'pos','sales_order','transfer','manual','physical_count',
    'replenishment','pick_wave'
  ]));

COMMENT ON CONSTRAINT stock_reservations_source_type_check ON public.stock_reservations IS
  'Allowed reservation sources. Must stay in sync with every p_source_type literal passed to reserve_stock_atomic (see supabase/tests/stock_reservation_source_types_test.sql).';