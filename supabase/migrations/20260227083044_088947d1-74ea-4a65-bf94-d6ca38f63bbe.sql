
-- Add org-level flag for payment methods on documents (Odoo-style)
ALTER TABLE public.organizations 
  ADD COLUMN IF NOT EXISTS show_payment_methods_on_documents boolean NOT NULL DEFAULT false;

-- Backfill: set true for orgs that already have any default template with show_payment_methods = true
UPDATE public.organizations o
SET show_payment_methods_on_documents = true
WHERE EXISTS (
  SELECT 1 FROM public.document_templates dt
  WHERE dt.organization_id = o.id
    AND dt.is_default = true
    AND dt.show_payment_methods = true
);
