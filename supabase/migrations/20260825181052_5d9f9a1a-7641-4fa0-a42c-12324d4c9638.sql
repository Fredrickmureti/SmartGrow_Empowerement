ALTER TABLE public.project_revenue_entries
  ADD COLUMN IF NOT EXISTS entry_nature text NOT NULL DEFAULT 'actual',
  ADD COLUMN IF NOT EXISTS amount_base numeric,
  ADD COLUMN IF NOT EXISTS fx_rate numeric,
  ADD COLUMN IF NOT EXISTS base_currency text;

ALTER TABLE public.project_revenue_entries
  DROP CONSTRAINT IF EXISTS project_revenue_entries_entry_nature_check;

ALTER TABLE public.project_revenue_entries
  ADD CONSTRAINT project_revenue_entries_entry_nature_check
  CHECK (entry_nature IN ('actual','commitment'));

COMMENT ON COLUMN public.project_revenue_entries.entry_nature IS
  'actual = earned/invoiced revenue that belongs in margin; commitment = confirmed but not yet invoiced (e.g. sales order). Never sum the two together.';
COMMENT ON COLUMN public.project_revenue_entries.amount_base IS
  'amount converted into base_currency using fx_rate. NULL means no rate was on file — report as unconverted, never treat as zero.';

DROP INDEX IF EXISTS public.uq_project_revenue_source;

CREATE UNIQUE INDEX IF NOT EXISTS uq_project_revenue_source_grain
  ON public.project_revenue_entries (
    source_type, source_id, project_id,
    COALESCE(milestone_id, '00000000-0000-0000-0000-000000000000'::uuid)
  )
  WHERE source_id IS NOT NULL AND source_type <> 'manual';

CREATE INDEX IF NOT EXISTS idx_project_revenue_project_nature
  ON public.project_revenue_entries (project_id, entry_nature, posted_at);