
-- Add migration_session_id to invoices, bills, and stock_movements for rollback tracking
ALTER TABLE public.invoices ADD COLUMN IF NOT EXISTS migration_session_id uuid REFERENCES public.migration_sessions(id) ON DELETE SET NULL;
ALTER TABLE public.bills ADD COLUMN IF NOT EXISTS migration_session_id uuid REFERENCES public.migration_sessions(id) ON DELETE SET NULL;
ALTER TABLE public.stock_movements ADD COLUMN IF NOT EXISTS migration_session_id uuid REFERENCES public.migration_sessions(id) ON DELETE SET NULL;

-- Add opening_balance_equity to default_account_settings mapping support
-- (No schema change needed - it uses the existing setting_key text column)

-- Create indexes for efficient rollback queries
CREATE INDEX IF NOT EXISTS idx_invoices_migration_session ON public.invoices(migration_session_id) WHERE migration_session_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_bills_migration_session ON public.bills(migration_session_id) WHERE migration_session_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_stock_movements_migration_session ON public.stock_movements(migration_session_id) WHERE migration_session_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_journal_entries_source_type_migration ON public.journal_entries(source_type) WHERE source_type = 'migration';
