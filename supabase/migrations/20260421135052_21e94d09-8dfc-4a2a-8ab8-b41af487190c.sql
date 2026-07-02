-- Phase 1 of branch-dimension audit: add the missing branch_id column
-- to sales-side tables that already received the business_id stamp but were
-- never extended with the branch dimension. Mirrors the pattern used for
-- invoices and bills.

-- Reuse the same enforce_branch_business_match() trigger function that
-- already guards bank_accounts / document_templates / payment methods.
-- It validates that the chosen branch belongs to the row's business.

-- ====== ESTIMATES ======
ALTER TABLE public.estimates
  ADD COLUMN IF NOT EXISTS branch_id uuid NULL
    REFERENCES public.branches(id) ON DELETE RESTRICT;
CREATE INDEX IF NOT EXISTS idx_estimates_branch ON public.estimates(branch_id);
DROP TRIGGER IF EXISTS trg_estimates_branch_business_match ON public.estimates;
CREATE TRIGGER trg_estimates_branch_business_match
  BEFORE INSERT OR UPDATE OF branch_id, business_id ON public.estimates
  FOR EACH ROW EXECUTE FUNCTION public.enforce_branch_business_match();

-- ====== PROFORMA_INVOICES ======
ALTER TABLE public.proforma_invoices
  ADD COLUMN IF NOT EXISTS branch_id uuid NULL
    REFERENCES public.branches(id) ON DELETE RESTRICT;
CREATE INDEX IF NOT EXISTS idx_proforma_invoices_branch ON public.proforma_invoices(branch_id);
DROP TRIGGER IF EXISTS trg_proforma_invoices_branch_business_match ON public.proforma_invoices;
CREATE TRIGGER trg_proforma_invoices_branch_business_match
  BEFORE INSERT OR UPDATE OF branch_id, business_id ON public.proforma_invoices
  FOR EACH ROW EXECUTE FUNCTION public.enforce_branch_business_match();

-- ====== RECURRING_INVOICES ======
ALTER TABLE public.recurring_invoices
  ADD COLUMN IF NOT EXISTS branch_id uuid NULL
    REFERENCES public.branches(id) ON DELETE RESTRICT;
CREATE INDEX IF NOT EXISTS idx_recurring_invoices_branch ON public.recurring_invoices(branch_id);
DROP TRIGGER IF EXISTS trg_recurring_invoices_branch_business_match ON public.recurring_invoices;
CREATE TRIGGER trg_recurring_invoices_branch_business_match
  BEFORE INSERT OR UPDATE OF branch_id, business_id ON public.recurring_invoices
  FOR EACH ROW EXECUTE FUNCTION public.enforce_branch_business_match();

-- ====== SALES_ORDERS ======
ALTER TABLE public.sales_orders
  ADD COLUMN IF NOT EXISTS branch_id uuid NULL
    REFERENCES public.branches(id) ON DELETE RESTRICT;
CREATE INDEX IF NOT EXISTS idx_sales_orders_branch ON public.sales_orders(branch_id);
DROP TRIGGER IF EXISTS trg_sales_orders_branch_business_match ON public.sales_orders;
CREATE TRIGGER trg_sales_orders_branch_business_match
  BEFORE INSERT OR UPDATE OF branch_id, business_id ON public.sales_orders
  FOR EACH ROW EXECUTE FUNCTION public.enforce_branch_business_match();

-- ====== DELIVERY_NOTES ======
ALTER TABLE public.delivery_notes
  ADD COLUMN IF NOT EXISTS branch_id uuid NULL
    REFERENCES public.branches(id) ON DELETE RESTRICT;
CREATE INDEX IF NOT EXISTS idx_delivery_notes_branch ON public.delivery_notes(branch_id);
DROP TRIGGER IF EXISTS trg_delivery_notes_branch_business_match ON public.delivery_notes;
CREATE TRIGGER trg_delivery_notes_branch_business_match
  BEFORE INSERT OR UPDATE OF branch_id, business_id ON public.delivery_notes
  FOR EACH ROW EXECUTE FUNCTION public.enforce_branch_business_match();

-- ====== VENDOR_CREDIT_NOTES ======
ALTER TABLE public.vendor_credit_notes
  ADD COLUMN IF NOT EXISTS branch_id uuid NULL
    REFERENCES public.branches(id) ON DELETE RESTRICT;
CREATE INDEX IF NOT EXISTS idx_vendor_credit_notes_branch ON public.vendor_credit_notes(branch_id);
DROP TRIGGER IF EXISTS trg_vendor_credit_notes_branch_business_match ON public.vendor_credit_notes;
CREATE TRIGGER trg_vendor_credit_notes_branch_business_match
  BEFORE INSERT OR UPDATE OF branch_id, business_id ON public.vendor_credit_notes
  FOR EACH ROW EXECUTE FUNCTION public.enforce_branch_business_match();

COMMENT ON COLUMN public.estimates.branch_id IS
  'OPTIONAL. NULL = estimate not attributed to a specific branch (company-wide). Non-NULL = branch attribution for per-branch sales reporting.';
COMMENT ON COLUMN public.sales_orders.branch_id IS
  'OPTIONAL. NULL = SO not attributed to a specific branch. Non-NULL = branch attribution for per-branch sales reporting.';