ALTER TABLE public.project_cost_entries
  ADD COLUMN IF NOT EXISTS entry_nature text NOT NULL DEFAULT 'actual',
  ADD COLUMN IF NOT EXISTS amount_base numeric,
  ADD COLUMN IF NOT EXISTS fx_rate numeric,
  ADD COLUMN IF NOT EXISTS base_currency text;

ALTER TABLE public.project_cost_entries
  DROP CONSTRAINT IF EXISTS project_cost_entries_entry_nature_check;

ALTER TABLE public.project_cost_entries
  ADD CONSTRAINT project_cost_entries_entry_nature_check
  CHECK (entry_nature IN ('actual','commitment'));

COMMENT ON COLUMN public.project_cost_entries.entry_nature IS
  'actual = incurred cost that belongs in margin; commitment = confirmed but not yet incurred (e.g. purchase order). Never sum the two together.';
COMMENT ON COLUMN public.project_cost_entries.amount_base IS
  'amount converted into base_currency using fx_rate. NULL means no rate was on file — such rows must be reported as unconverted, never silently treated as zero or as base currency.';

DROP INDEX IF EXISTS public.uq_project_cost_source;

CREATE UNIQUE INDEX IF NOT EXISTS uq_project_cost_source_grain
  ON public.project_cost_entries (
    source_type, source_id, project_id,
    COALESCE(task_id, '00000000-0000-0000-0000-000000000000'::uuid)
  )
  WHERE source_id IS NOT NULL AND source_type <> 'manual';

CREATE INDEX IF NOT EXISTS idx_project_cost_project_nature
  ON public.project_cost_entries (project_id, entry_nature, posted_at);