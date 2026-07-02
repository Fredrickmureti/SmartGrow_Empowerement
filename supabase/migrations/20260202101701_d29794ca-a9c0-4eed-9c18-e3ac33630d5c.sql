-- Fix: add admin delete policy for invoices (correct quoting)
DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'invoices'
      AND policyname = 'Platform admins can delete invoices'
  ) THEN
    EXECUTE 'CREATE POLICY "Platform admins can delete invoices"
      ON public.invoices
      FOR DELETE
      TO authenticated
      USING (is_platform_admin(auth.uid()))';
  END IF;
END
$do$;