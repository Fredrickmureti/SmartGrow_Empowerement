
-- =========================================================
-- WAVE A.1: Convert SET NULL / CASCADE to RESTRICT on business_id FKs
-- =========================================================

ALTER TABLE public.journal_entries DROP CONSTRAINT IF EXISTS journal_entries_business_id_fkey;
ALTER TABLE public.journal_entries
  ADD CONSTRAINT journal_entries_business_id_fkey
  FOREIGN KEY (business_id) REFERENCES public.businesses(id) ON DELETE RESTRICT;

ALTER TABLE public.payments DROP CONSTRAINT IF EXISTS payments_business_id_fkey;
ALTER TABLE public.payments
  ADD CONSTRAINT payments_business_id_fkey
  FOREIGN KEY (business_id) REFERENCES public.businesses(id) ON DELETE RESTRICT;

ALTER TABLE public.pos_registers DROP CONSTRAINT IF EXISTS pos_registers_business_id_fkey;
ALTER TABLE public.pos_registers
  ADD CONSTRAINT pos_registers_business_id_fkey
  FOREIGN KEY (business_id) REFERENCES public.businesses(id) ON DELETE RESTRICT;

ALTER TABLE public.tax_rates DROP CONSTRAINT IF EXISTS tax_rates_business_id_fkey;
ALTER TABLE public.tax_rates
  ADD CONSTRAINT tax_rates_business_id_fkey
  FOREIGN KEY (business_id) REFERENCES public.businesses(id) ON DELETE RESTRICT;

ALTER TABLE public.products DROP CONSTRAINT IF EXISTS products_business_id_fkey;
ALTER TABLE public.products
  ADD CONSTRAINT products_business_id_fkey
  FOREIGN KEY (business_id) REFERENCES public.businesses(id) ON DELETE RESTRICT;

ALTER TABLE public.warehouses DROP CONSTRAINT IF EXISTS warehouses_business_id_fkey;
ALTER TABLE public.warehouses
  ADD CONSTRAINT warehouses_business_id_fkey
  FOREIGN KEY (business_id) REFERENCES public.businesses(id) ON DELETE RESTRICT;

ALTER TABLE public.employees DROP CONSTRAINT IF EXISTS employees_business_id_fkey;
ALTER TABLE public.employees
  ADD CONSTRAINT employees_business_id_fkey
  FOREIGN KEY (business_id) REFERENCES public.businesses(id) ON DELETE RESTRICT;

ALTER TABLE public.estimates DROP CONSTRAINT IF EXISTS estimates_business_id_fkey;
ALTER TABLE public.estimates
  ADD CONSTRAINT estimates_business_id_fkey
  FOREIGN KEY (business_id) REFERENCES public.businesses(id) ON DELETE RESTRICT;

ALTER TABLE public.expenses DROP CONSTRAINT IF EXISTS expenses_business_id_fkey;
ALTER TABLE public.expenses
  ADD CONSTRAINT expenses_business_id_fkey
  FOREIGN KEY (business_id) REFERENCES public.businesses(id) ON DELETE RESTRICT;

ALTER TABLE public.fixed_assets DROP CONSTRAINT IF EXISTS fixed_assets_business_id_fkey;
ALTER TABLE public.fixed_assets
  ADD CONSTRAINT fixed_assets_business_id_fkey
  FOREIGN KEY (business_id) REFERENCES public.businesses(id) ON DELETE RESTRICT;

ALTER TABLE public.sales_orders DROP CONSTRAINT IF EXISTS sales_orders_business_id_fkey;
ALTER TABLE public.sales_orders
  ADD CONSTRAINT sales_orders_business_id_fkey
  FOREIGN KEY (business_id) REFERENCES public.businesses(id) ON DELETE RESTRICT;

ALTER TABLE public.purchase_orders DROP CONSTRAINT IF EXISTS purchase_orders_business_id_fkey;
ALTER TABLE public.purchase_orders
  ADD CONSTRAINT purchase_orders_business_id_fkey
  FOREIGN KEY (business_id) REFERENCES public.businesses(id) ON DELETE RESTRICT;

ALTER TABLE public.fiscal_periods DROP CONSTRAINT IF EXISTS fiscal_periods_business_id_fkey;
ALTER TABLE public.fiscal_periods
  ADD CONSTRAINT fiscal_periods_business_id_fkey
  FOREIGN KEY (business_id) REFERENCES public.businesses(id) ON DELETE RESTRICT;

-- =========================================================
-- WAVE A.2: enforce_branch_business_match trigger function
-- Ensures that if branch_id is set, it must belong to the same business_id
-- =========================================================

CREATE OR REPLACE FUNCTION public.enforce_branch_business_match()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_branch_business_id uuid;
BEGIN
  IF NEW.branch_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT business_id INTO v_branch_business_id
  FROM public.branches
  WHERE id = NEW.branch_id;

  IF v_branch_business_id IS NULL THEN
    RAISE EXCEPTION 'Branch % does not exist', NEW.branch_id
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  IF v_branch_business_id <> NEW.business_id THEN
    RAISE EXCEPTION 'Branch % belongs to Company %, but record is assigned to Company %. Cross-Company branch override is not allowed.',
      NEW.branch_id, v_branch_business_id, NEW.business_id
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

-- Attach to all tables with optional branch_id overrides
DROP TRIGGER IF EXISTS trg_enforce_branch_business_match ON public.bank_accounts;
CREATE TRIGGER trg_enforce_branch_business_match
  BEFORE INSERT OR UPDATE OF branch_id, business_id ON public.bank_accounts
  FOR EACH ROW EXECUTE FUNCTION public.enforce_branch_business_match();

DROP TRIGGER IF EXISTS trg_enforce_branch_business_match ON public.document_templates;
CREATE TRIGGER trg_enforce_branch_business_match
  BEFORE INSERT OR UPDATE OF branch_id, business_id ON public.document_templates
  FOR EACH ROW EXECUTE FUNCTION public.enforce_branch_business_match();

DROP TRIGGER IF EXISTS trg_enforce_branch_business_match ON public.organization_payment_methods;
CREATE TRIGGER trg_enforce_branch_business_match
  BEFORE INSERT OR UPDATE OF branch_id, business_id ON public.organization_payment_methods
  FOR EACH ROW EXECUTE FUNCTION public.enforce_branch_business_match();

DROP TRIGGER IF EXISTS trg_enforce_branch_business_match ON public.organization_payment_gateways;
CREATE TRIGGER trg_enforce_branch_business_match
  BEFORE INSERT OR UPDATE OF branch_id, business_id ON public.organization_payment_gateways
  FOR EACH ROW EXECUTE FUNCTION public.enforce_branch_business_match();
