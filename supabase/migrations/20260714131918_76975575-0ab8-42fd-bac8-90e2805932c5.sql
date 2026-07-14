
ALTER TABLE public.procurement_recommendations REPLICA IDENTITY FULL;
ALTER TABLE public.replenishment_runs REPLICA IDENTITY FULL;
ALTER PUBLICATION supabase_realtime ADD TABLE public.procurement_recommendations;
ALTER PUBLICATION supabase_realtime ADD TABLE public.replenishment_runs;
