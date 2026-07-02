-- Enable RLS on stock_movements_orphans (created in previous migration)
ALTER TABLE public.stock_movements_orphans ENABLE ROW LEVEL SECURITY;

-- Only org admins/owners can read orphan rows for their org. No insert/update/delete via API.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'stock_movements_orphans'
      AND policyname = 'Org admins can view orphan movements'
  ) THEN
    CREATE POLICY "Org admins can view orphan movements"
      ON public.stock_movements_orphans
      FOR SELECT
      TO authenticated
      USING (
        EXISTS (
          SELECT 1 FROM public.user_roles ur
          WHERE ur.user_id = auth.uid()
            AND ur.organization_id = stock_movements_orphans.organization_id
            AND ur.role IN ('owner', 'admin')
        )
      );
  END IF;
END $$;