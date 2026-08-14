-- pgTAP — Phase 4: Warehouse consumes the Inventory ledger, never re-models it.
--
-- Boundary under test (ADR 0064 / ADR 0079):
--   * `stock_quants.lpn_id`      = the physical container (license plate)
--   * `stock_quants.package_id`  = the reusable product_packaging definition
-- A WMS function that stamps a plate id into `package_id` corrupts the Product
-- foundation's packaging dimension AND can never match the plate quants the
-- LPN primitives maintain. `wms_split_putaway_task` did exactly that before
-- Phase 4, and posted no `stock_movements` for a real bin-to-bin move.
--
-- Movement rows written by plate operations carry reference_type 'wms_lpn',
-- which `_maintain_stock_quants` deliberately skips — the plate function owns
-- the quant relocation. That contract is pinned here too: if the trigger stops
-- skipping, every plate move would double-apply its balance.
--
-- Structural checks, consistent with wms_dispatch_relieves_inventory_test.sql.
--
-- Run with:  select * from runtests('public'::name);  (after `create extension pgtap;`)

BEGIN;

SELECT plan(12);

-- ------------------------------------------------------------------
-- I1. The two quant identity columns exist and point at the right foundations.
-- ------------------------------------------------------------------
SELECT has_column('public', 'stock_quants', 'lpn_id', 'stock_quants.lpn_id exists');
SELECT has_column('public', 'stock_quants', 'package_id', 'stock_quants.package_id exists');

SELECT is(
  (SELECT confrelid::regclass::text FROM pg_constraint
    WHERE conrelid = 'public.stock_quants'::regclass AND conname = 'stock_quants_package_id_fkey'),
  'product_packaging',
  'package_id references the canonical product_packaging definition'
);

SELECT is(
  (SELECT confrelid::regclass::text FROM pg_constraint
    WHERE conrelid = 'public.stock_quants'::regclass AND conname = 'stock_quants_lpn_id_fkey'),
  'wms_license_plates',
  'lpn_id references the physical license plate'
);

-- ------------------------------------------------------------------
-- I2. No live row confuses the two dimensions.
-- ------------------------------------------------------------------
SELECT is(
  (SELECT count(*)::int FROM public.stock_quants q
     JOIN public.wms_license_plates l ON l.id = q.package_id),
  0,
  'no stock_quants row carries a license plate in package_id'
);

-- ------------------------------------------------------------------
-- I3. A trigger stops it from happening again.
-- ------------------------------------------------------------------
SELECT has_trigger(
  'public', 'stock_quants', 'trg_stock_quants_package_id_is_packaging',
  'package_id/lpn_id confusion is blocked by a trigger'
);

SELECT ok(
  pg_get_functiondef('public._stock_quants_package_id_is_packaging()'::regprocedure)
    LIKE '%INVENTORY_QUANT_PACKAGE_IS_LPN%',
  'the guard raises a diagnosable error code'
);

-- ------------------------------------------------------------------
-- I4. Partial putaway resolves the staged quant by plate, not by packaging.
-- ------------------------------------------------------------------
SELECT ok(
  pg_get_functiondef('public.wms_split_putaway_task(uuid,integer,numeric,uuid,text)'::regprocedure)
    ~ 'WHERE lpn_id = v_task\.lpn_id',
  'partial putaway locates the staged quant via lpn_id'
);

SELECT ok(
  pg_get_functiondef('public.wms_split_putaway_task(uuid,integer,numeric,uuid,text)'::regprocedure)
    !~ 'package_id = v_task\.lpn_id',
  'partial putaway never matches a plate through package_id'
);

-- ------------------------------------------------------------------
-- I5. Partial putaway leaves a movement audit trail for the physical move.
-- ------------------------------------------------------------------
SELECT ok(
  pg_get_functiondef('public.wms_split_putaway_task(uuid,integer,numeric,uuid,text)'::regprocedure)
    ~ 'INSERT INTO public\.stock_movements[\s\S]{0,1200}transfer_out[\s\S]{0,600}transfer_in',
  'partial putaway posts paired transfer_out / transfer_in movements'
);

SELECT ok(
  pg_get_functiondef('public.wms_split_putaway_task(uuid,integer,numeric,uuid,text)'::regprocedure)
    LIKE '%''wms_lpn''%',
  'those movements are tagged wms_lpn so the quant trigger does not double-apply'
);

-- ------------------------------------------------------------------
-- I6. The trigger contract that makes I5 safe.
-- ------------------------------------------------------------------
SELECT ok(
  pg_get_functiondef('public._maintain_stock_quants()'::regprocedure)
    ~ 'reference_type = ''wms_lpn'' THEN RETURN NEW',
  '_maintain_stock_quants skips plate-owned movements'
);

SELECT * FROM finish();
ROLLBACK;
