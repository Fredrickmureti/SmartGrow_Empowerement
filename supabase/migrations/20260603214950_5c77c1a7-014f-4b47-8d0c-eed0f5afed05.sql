ALTER TABLE public.projects
  ADD COLUMN IF NOT EXISTS source_lead_id uuid REFERENCES public.crm_leads(id),
  ADD COLUMN IF NOT EXISTS source_sales_order_id uuid REFERENCES public.sales_orders(id);

CREATE INDEX IF NOT EXISTS idx_projects_source_lead_id ON public.projects(source_lead_id);
CREATE INDEX IF NOT EXISTS idx_projects_source_sales_order_id ON public.projects(source_sales_order_id);