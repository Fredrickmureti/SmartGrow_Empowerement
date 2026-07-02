-- U3: Write-off account column on default_account_mappings
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_schema = 'public' AND table_name = 'default_account_mappings' AND column_name = 'writeoff_account_id'
  ) THEN
    ALTER TABLE public.default_account_mappings ADD COLUMN writeoff_account_id uuid REFERENCES public.accounts(id);
  END IF;
END $$;