ALTER TABLE public.invoices
  ADD COLUMN IF NOT EXISTS bill_to_contact_id uuid REFERENCES public.contacts(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS billing_address text;

ALTER TABLE public.credit_notes
  ADD COLUMN IF NOT EXISTS bill_to_contact_id uuid REFERENCES public.contacts(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS billing_address text;

ALTER TABLE public.estimates
  ADD COLUMN IF NOT EXISTS bill_to_contact_id uuid REFERENCES public.contacts(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS billing_address text;

ALTER TABLE public.proforma_invoices
  ADD COLUMN IF NOT EXISTS bill_to_contact_id uuid REFERENCES public.contacts(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS billing_address text;

ALTER TABLE public.bills
  ADD COLUMN IF NOT EXISTS remit_to_contact_id uuid REFERENCES public.contacts(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS remit_to_address text;

CREATE INDEX IF NOT EXISTS idx_invoices_bill_to_contact_id ON public.invoices(bill_to_contact_id);
CREATE INDEX IF NOT EXISTS idx_credit_notes_bill_to_contact_id ON public.credit_notes(bill_to_contact_id);
CREATE INDEX IF NOT EXISTS idx_estimates_bill_to_contact_id ON public.estimates(bill_to_contact_id);
CREATE INDEX IF NOT EXISTS idx_proforma_invoices_bill_to_contact_id ON public.proforma_invoices(bill_to_contact_id);
CREATE INDEX IF NOT EXISTS idx_bills_remit_to_contact_id ON public.bills(remit_to_contact_id);