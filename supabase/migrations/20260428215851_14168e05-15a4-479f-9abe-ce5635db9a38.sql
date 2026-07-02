-- Fix realtime "Products subscription failed: CHANNEL_ERROR" by adding the
-- product/inventory tables to the supabase_realtime publication and forcing
-- REPLICA IDENTITY FULL so DELETE payloads carry the full old row (the
-- product realtime hook reads payload.old on DELETE).

ALTER TABLE public.products REPLICA IDENTITY FULL;
ALTER TABLE public.warehouse_stock REPLICA IDENTITY FULL;
ALTER TABLE public.stock_movements REPLICA IDENTITY FULL;
ALTER TABLE public.stock_adjustments REPLICA IDENTITY FULL;

DO $$ BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE public.products;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE public.warehouse_stock;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE public.stock_movements;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE public.stock_adjustments;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;