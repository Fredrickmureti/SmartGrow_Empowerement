-- ============================================================================
-- Landed Cost — Phase C: retire the parallel verification path
-- landed_cost_selftest / landed_cost_selftest_run were a second, non-canonical
-- verification route that mutated valuation state and stock movements inside a
-- rolled-back transaction. Every assertion they made is now covered by the
-- supabase/tests/landed_cost_* probe files, which run against real data without
-- a privileged in-database harness. Retiring them removes a writer that had to
-- be permanently exempted in two single-writer registries.
-- ============================================================================
DROP FUNCTION IF EXISTS public.landed_cost_selftest_run(uuid, uuid);
DROP FUNCTION IF EXISTS public.landed_cost_selftest(uuid, uuid);

DELETE FROM public.inventory_valuation_writers WHERE function_name = 'landed_cost_selftest';
DELETE FROM public.stock_movement_writers      WHERE function_name = 'landed_cost_selftest';