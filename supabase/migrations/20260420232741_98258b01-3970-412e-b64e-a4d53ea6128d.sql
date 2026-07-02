-- =========================================================================
-- WAVE 2 — Per-table FK rewrites to ON DELETE RESTRICT
-- (explicit statements, no dynamic loop, no shared locks)
-- =========================================================================

ALTER TABLE public.accounts DROP CONSTRAINT IF EXISTS accounts_business_id_fkey;
ALTER TABLE public.accounts ADD CONSTRAINT accounts_business_id_fkey
  FOREIGN KEY (business_id) REFERENCES public.businesses(id) ON DELETE RESTRICT;

ALTER TABLE public.bank_accounts DROP CONSTRAINT IF EXISTS bank_accounts_business_id_fkey;
ALTER TABLE public.bank_accounts ADD CONSTRAINT bank_accounts_business_id_fkey
  FOREIGN KEY (business_id) REFERENCES public.businesses(id) ON DELETE RESTRICT;

ALTER TABLE public.contacts DROP CONSTRAINT IF EXISTS contacts_business_id_fkey;
ALTER TABLE public.contacts ADD CONSTRAINT contacts_business_id_fkey
  FOREIGN KEY (business_id) REFERENCES public.businesses(id) ON DELETE RESTRICT;

ALTER TABLE public.invoices DROP CONSTRAINT IF EXISTS invoices_business_id_fkey;
ALTER TABLE public.invoices ADD CONSTRAINT invoices_business_id_fkey
  FOREIGN KEY (business_id) REFERENCES public.businesses(id) ON DELETE RESTRICT;

ALTER TABLE public.bills DROP CONSTRAINT IF EXISTS bills_business_id_fkey;
ALTER TABLE public.bills ADD CONSTRAINT bills_business_id_fkey
  FOREIGN KEY (business_id) REFERENCES public.businesses(id) ON DELETE RESTRICT;

ALTER TABLE public.credit_notes DROP CONSTRAINT IF EXISTS credit_notes_business_id_fkey;
ALTER TABLE public.credit_notes ADD CONSTRAINT credit_notes_business_id_fkey
  FOREIGN KEY (business_id) REFERENCES public.businesses(id) ON DELETE RESTRICT;

ALTER TABLE public.bill_payments DROP CONSTRAINT IF EXISTS bill_payments_business_id_fkey;
ALTER TABLE public.bill_payments ADD CONSTRAINT bill_payments_business_id_fkey
  FOREIGN KEY (business_id) REFERENCES public.businesses(id) ON DELETE RESTRICT;

ALTER TABLE public.bank_transactions DROP CONSTRAINT IF EXISTS bank_transactions_business_id_fkey;
ALTER TABLE public.bank_transactions ADD CONSTRAINT bank_transactions_business_id_fkey
  FOREIGN KEY (business_id) REFERENCES public.businesses(id) ON DELETE RESTRICT;

ALTER TABLE public.bank_statements DROP CONSTRAINT IF EXISTS bank_statements_business_id_fkey;
ALTER TABLE public.bank_statements ADD CONSTRAINT bank_statements_business_id_fkey
  FOREIGN KEY (business_id) REFERENCES public.businesses(id) ON DELETE RESTRICT;

ALTER TABLE public.bank_reconciliation_sessions DROP CONSTRAINT IF EXISTS bank_reconciliation_sessions_business_id_fkey;
ALTER TABLE public.bank_reconciliation_sessions ADD CONSTRAINT bank_reconciliation_sessions_business_id_fkey
  FOREIGN KEY (business_id) REFERENCES public.businesses(id) ON DELETE RESTRICT;

ALTER TABLE public.customer_statements DROP CONSTRAINT IF EXISTS customer_statements_business_id_fkey;
ALTER TABLE public.customer_statements ADD CONSTRAINT customer_statements_business_id_fkey
  FOREIGN KEY (business_id) REFERENCES public.businesses(id) ON DELETE RESTRICT;

ALTER TABLE public.budgets DROP CONSTRAINT IF EXISTS budgets_business_id_fkey;
ALTER TABLE public.budgets ADD CONSTRAINT budgets_business_id_fkey
  FOREIGN KEY (business_id) REFERENCES public.businesses(id) ON DELETE RESTRICT;

ALTER TABLE public.backorders DROP CONSTRAINT IF EXISTS backorders_business_id_fkey;
ALTER TABLE public.backorders ADD CONSTRAINT backorders_business_id_fkey
  FOREIGN KEY (business_id) REFERENCES public.businesses(id) ON DELETE RESTRICT;

ALTER TABLE public.attendance DROP CONSTRAINT IF EXISTS attendance_business_id_fkey;
ALTER TABLE public.attendance ADD CONSTRAINT attendance_business_id_fkey
  FOREIGN KEY (business_id) REFERENCES public.businesses(id) ON DELETE RESTRICT;

ALTER TABLE public.approval_workflows DROP CONSTRAINT IF EXISTS approval_workflows_business_id_fkey;
ALTER TABLE public.approval_workflows ADD CONSTRAINT approval_workflows_business_id_fkey
  FOREIGN KEY (business_id) REFERENCES public.businesses(id) ON DELETE RESTRICT;

-- =========================================================================
-- WAVE 3 — Re-parent payment & template settings
-- =========================================================================

-- 1. organization_payment_methods → business_id NOT NULL + branch_id
ALTER TABLE public.organization_payment_methods
  ADD COLUMN IF NOT EXISTS business_id uuid,
  ADD COLUMN IF NOT EXISTS branch_id uuid;

UPDATE public.organization_payment_methods opm
SET business_id = (
  SELECT b.id FROM public.businesses b
  WHERE b.organization_id = opm.organization_id
  ORDER BY b.created_at ASC LIMIT 1
)
WHERE business_id IS NULL;

ALTER TABLE public.organization_payment_methods ALTER COLUMN business_id SET NOT NULL;

ALTER TABLE public.organization_payment_methods
  DROP CONSTRAINT IF EXISTS organization_payment_methods_business_id_fkey;
ALTER TABLE public.organization_payment_methods
  ADD CONSTRAINT organization_payment_methods_business_id_fkey
  FOREIGN KEY (business_id) REFERENCES public.businesses(id) ON DELETE RESTRICT;

ALTER TABLE public.organization_payment_methods
  DROP CONSTRAINT IF EXISTS organization_payment_methods_branch_id_fkey;
ALTER TABLE public.organization_payment_methods
  ADD CONSTRAINT organization_payment_methods_branch_id_fkey
  FOREIGN KEY (branch_id) REFERENCES public.branches(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_org_pm_business ON public.organization_payment_methods(business_id);
CREATE INDEX IF NOT EXISTS idx_org_pm_branch ON public.organization_payment_methods(branch_id);

-- 2. organization_payment_gateways
ALTER TABLE public.organization_payment_gateways
  ADD COLUMN IF NOT EXISTS business_id uuid,
  ADD COLUMN IF NOT EXISTS branch_id uuid;

UPDATE public.organization_payment_gateways opg
SET business_id = (
  SELECT b.id FROM public.businesses b
  WHERE b.organization_id = opg.organization_id
  ORDER BY b.created_at ASC LIMIT 1
)
WHERE business_id IS NULL;

ALTER TABLE public.organization_payment_gateways ALTER COLUMN business_id SET NOT NULL;

ALTER TABLE public.organization_payment_gateways
  DROP CONSTRAINT IF EXISTS organization_payment_gateways_business_id_fkey;
ALTER TABLE public.organization_payment_gateways
  ADD CONSTRAINT organization_payment_gateways_business_id_fkey
  FOREIGN KEY (business_id) REFERENCES public.businesses(id) ON DELETE RESTRICT;

ALTER TABLE public.organization_payment_gateways
  DROP CONSTRAINT IF EXISTS organization_payment_gateways_branch_id_fkey;
ALTER TABLE public.organization_payment_gateways
  ADD CONSTRAINT organization_payment_gateways_branch_id_fkey
  FOREIGN KEY (branch_id) REFERENCES public.branches(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_org_pg_business ON public.organization_payment_gateways(business_id);

-- 3. pos_payment_methods
ALTER TABLE public.pos_payment_methods
  ADD COLUMN IF NOT EXISTS business_id uuid,
  ADD COLUMN IF NOT EXISTS branch_id uuid;

UPDATE public.pos_payment_methods ppm
SET business_id = (
  SELECT b.id FROM public.businesses b
  WHERE b.organization_id = ppm.organization_id
  ORDER BY b.created_at ASC LIMIT 1
)
WHERE business_id IS NULL;

ALTER TABLE public.pos_payment_methods ALTER COLUMN business_id SET NOT NULL;

ALTER TABLE public.pos_payment_methods
  DROP CONSTRAINT IF EXISTS pos_payment_methods_business_id_fkey;
ALTER TABLE public.pos_payment_methods
  ADD CONSTRAINT pos_payment_methods_business_id_fkey
  FOREIGN KEY (business_id) REFERENCES public.businesses(id) ON DELETE RESTRICT;

ALTER TABLE public.pos_payment_methods
  DROP CONSTRAINT IF EXISTS pos_payment_methods_branch_id_fkey;
ALTER TABLE public.pos_payment_methods
  ADD CONSTRAINT pos_payment_methods_branch_id_fkey
  FOREIGN KEY (branch_id) REFERENCES public.branches(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_pos_pm_business ON public.pos_payment_methods(business_id);

-- 4. payment_terms → business_id NOT NULL
UPDATE public.payment_terms pt
SET business_id = (
  SELECT b.id FROM public.businesses b
  WHERE b.organization_id = pt.organization_id
  ORDER BY b.created_at ASC LIMIT 1
)
WHERE business_id IS NULL;

ALTER TABLE public.payment_terms ALTER COLUMN business_id SET NOT NULL;

ALTER TABLE public.payment_terms DROP CONSTRAINT IF EXISTS payment_terms_business_id_fkey;
ALTER TABLE public.payment_terms ADD CONSTRAINT payment_terms_business_id_fkey
  FOREIGN KEY (business_id) REFERENCES public.businesses(id) ON DELETE RESTRICT;

-- 5. document_templates → business_id NOT NULL + branch_id override
ALTER TABLE public.document_templates ADD COLUMN IF NOT EXISTS branch_id uuid;

UPDATE public.document_templates dt
SET business_id = (
  SELECT b.id FROM public.businesses b
  WHERE b.organization_id = dt.organization_id
  ORDER BY b.created_at ASC LIMIT 1
)
WHERE business_id IS NULL;

ALTER TABLE public.document_templates ALTER COLUMN business_id SET NOT NULL;

ALTER TABLE public.document_templates DROP CONSTRAINT IF EXISTS document_templates_business_id_fkey;
ALTER TABLE public.document_templates ADD CONSTRAINT document_templates_business_id_fkey
  FOREIGN KEY (business_id) REFERENCES public.businesses(id) ON DELETE RESTRICT;

ALTER TABLE public.document_templates DROP CONSTRAINT IF EXISTS document_templates_branch_id_fkey;
ALTER TABLE public.document_templates ADD CONSTRAINT document_templates_branch_id_fkey
  FOREIGN KEY (branch_id) REFERENCES public.branches(id) ON DELETE SET NULL;

-- 6. email_templates → business_id NOT NULL
UPDATE public.email_templates et
SET business_id = (
  SELECT b.id FROM public.businesses b
  WHERE b.organization_id = et.organization_id
  ORDER BY b.created_at ASC LIMIT 1
)
WHERE business_id IS NULL;

ALTER TABLE public.email_templates ALTER COLUMN business_id SET NOT NULL;

ALTER TABLE public.email_templates DROP CONSTRAINT IF EXISTS email_templates_business_id_fkey;
ALTER TABLE public.email_templates ADD CONSTRAINT email_templates_business_id_fkey
  FOREIGN KEY (business_id) REFERENCES public.businesses(id) ON DELETE RESTRICT;

-- 7. bank_accounts → optional branch_id for branch-restricted accounts
ALTER TABLE public.bank_accounts ADD COLUMN IF NOT EXISTS branch_id uuid;

ALTER TABLE public.bank_accounts DROP CONSTRAINT IF EXISTS bank_accounts_branch_id_fkey;
ALTER TABLE public.bank_accounts ADD CONSTRAINT bank_accounts_branch_id_fkey
  FOREIGN KEY (branch_id) REFERENCES public.branches(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_bank_accounts_branch ON public.bank_accounts(branch_id);

-- =========================================================================
-- TRIGGER: bank account currency must equal Company base currency
-- =========================================================================
CREATE OR REPLACE FUNCTION public.enforce_bank_account_currency()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_base_currency text;
BEGIN
  IF NEW.currency IS NULL THEN
    SELECT base_currency INTO NEW.currency
    FROM public.businesses WHERE id = NEW.business_id;
    RETURN NEW;
  END IF;

  SELECT base_currency INTO v_base_currency
  FROM public.businesses WHERE id = NEW.business_id;

  IF v_base_currency IS NOT NULL AND NEW.currency <> v_base_currency THEN
    RAISE EXCEPTION
      'Bank account currency % does not match Company base currency %. Multi-currency bank accounts require enabling additional currencies on the Company first.',
      NEW.currency, v_base_currency;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_enforce_bank_account_currency ON public.bank_accounts;
CREATE TRIGGER trg_enforce_bank_account_currency
  BEFORE INSERT OR UPDATE OF currency, business_id
  ON public.bank_accounts
  FOR EACH ROW EXECUTE FUNCTION public.enforce_bank_account_currency();

-- =========================================================================
-- COMPANY-SCOPED UNIQUENESS
-- =========================================================================
DROP INDEX IF EXISTS public.accounts_organization_id_code_key;
CREATE UNIQUE INDEX IF NOT EXISTS accounts_business_code_uniq
  ON public.accounts(business_id, code);

DROP INDEX IF EXISTS public.tax_rates_organization_id_name_key;
CREATE UNIQUE INDEX IF NOT EXISTS tax_rates_business_name_uniq
  ON public.tax_rates(business_id, name) WHERE is_active = true;

-- =========================================================================
-- DOCUMENTATION
-- =========================================================================
COMMENT ON TABLE public.organization_payment_methods IS
  'Payment methods configured by a Company (legal entity). Optionally restricted to a Branch via branch_id. Workspace-level access is deprecated.';

COMMENT ON TABLE public.organization_payment_gateways IS
  'Payment gateway credentials owned by a Company (legal entity). PCI/regulatory: provider credentials are bound to a legal entity, not a workspace.';

COMMENT ON COLUMN public.bank_accounts.branch_id IS
  'OPTIONAL. NULL = bank account shared across all branches of the parent Company. Non-NULL = restricted to a specific Branch.';

COMMENT ON COLUMN public.document_templates.branch_id IS
  'OPTIONAL. NULL = template applies to all branches of the parent Company. Non-NULL = branch override.';
