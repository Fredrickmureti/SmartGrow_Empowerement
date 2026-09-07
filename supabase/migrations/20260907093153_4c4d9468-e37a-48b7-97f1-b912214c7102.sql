ALTER TABLE public.branches
  DROP COLUMN IF EXISTS invoice_prefix_suffix,
  DROP COLUMN IF EXISTS default_warehouse_id;