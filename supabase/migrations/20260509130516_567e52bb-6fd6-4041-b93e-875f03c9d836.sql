ALTER TABLE public.invoice_items
  ADD COLUMN IF NOT EXISTS milestone_id uuid REFERENCES public.project_milestones(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_invoice_items_milestone ON public.invoice_items(milestone_id) WHERE milestone_id IS NOT NULL;

ALTER TABLE public.project_milestones
  ADD COLUMN IF NOT EXISTS invoice_id uuid REFERENCES public.invoices(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS is_invoiced boolean NOT NULL DEFAULT false;

ALTER TABLE public.project_tasks
  ADD COLUMN IF NOT EXISTS recurrence_parent_id uuid REFERENCES public.project_tasks(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS recurrence_next_at date,
  ADD COLUMN IF NOT EXISTS scheduled_for date;

CREATE UNIQUE INDEX IF NOT EXISTS uq_project_tasks_recurrence_instance
  ON public.project_tasks (recurrence_parent_id, scheduled_for)
  WHERE recurrence_parent_id IS NOT NULL AND scheduled_for IS NOT NULL;
