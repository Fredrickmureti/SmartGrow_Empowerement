-- Backfill existing data to assign business_id from the first active business in each organization
-- This ensures existing records are properly scoped to businesses

-- Helper function to get default business for an org
CREATE OR REPLACE FUNCTION public.get_default_business_for_backfill(_org_id uuid)
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT id FROM businesses 
  WHERE organization_id = _org_id AND is_active = true 
  ORDER BY created_at ASC LIMIT 1;
$$;

-- Backfill invoices
UPDATE invoices SET business_id = get_default_business_for_backfill(organization_id)
WHERE business_id IS NULL;

-- Backfill contacts
UPDATE contacts SET business_id = get_default_business_for_backfill(organization_id)
WHERE business_id IS NULL;

-- Backfill products
UPDATE products SET business_id = get_default_business_for_backfill(organization_id)
WHERE business_id IS NULL;

-- Backfill expenses
UPDATE expenses SET business_id = get_default_business_for_backfill(organization_id)
WHERE business_id IS NULL;

-- Backfill estimates
UPDATE estimates SET business_id = get_default_business_for_backfill(organization_id)
WHERE business_id IS NULL;

-- Backfill bills
UPDATE bills SET business_id = get_default_business_for_backfill(organization_id)
WHERE business_id IS NULL;

-- Backfill purchase_orders
UPDATE purchase_orders SET business_id = get_default_business_for_backfill(organization_id)
WHERE business_id IS NULL;

-- Backfill sales_orders
UPDATE sales_orders SET business_id = get_default_business_for_backfill(organization_id)
WHERE business_id IS NULL;

-- Backfill delivery_notes
UPDATE delivery_notes SET business_id = get_default_business_for_backfill(organization_id)
WHERE business_id IS NULL;

-- Backfill credit_notes
UPDATE credit_notes SET business_id = get_default_business_for_backfill(organization_id)
WHERE business_id IS NULL;

-- Backfill proforma_invoices
UPDATE proforma_invoices SET business_id = get_default_business_for_backfill(organization_id)
WHERE business_id IS NULL;

-- Backfill bank_accounts
UPDATE bank_accounts SET business_id = get_default_business_for_backfill(organization_id)
WHERE business_id IS NULL;

-- Backfill payments
UPDATE payments SET business_id = get_default_business_for_backfill(organization_id)
WHERE business_id IS NULL;

-- Backfill employees
UPDATE employees SET business_id = get_default_business_for_backfill(organization_id)
WHERE business_id IS NULL;

-- Backfill accounts
UPDATE accounts SET business_id = get_default_business_for_backfill(organization_id)
WHERE business_id IS NULL;

-- Backfill journal_entries
UPDATE journal_entries SET business_id = get_default_business_for_backfill(organization_id)
WHERE business_id IS NULL;

-- Backfill budgets
UPDATE budgets SET business_id = get_default_business_for_backfill(organization_id)
WHERE business_id IS NULL;

-- Backfill payroll_runs
UPDATE payroll_runs SET business_id = get_default_business_for_backfill(organization_id)
WHERE business_id IS NULL;

-- Backfill recurring_invoices
UPDATE recurring_invoices SET business_id = get_default_business_for_backfill(organization_id)
WHERE business_id IS NULL;

-- Backfill sales_returns
UPDATE sales_returns SET business_id = get_default_business_for_backfill(organization_id)
WHERE business_id IS NULL;

-- Backfill purchase_returns
UPDATE purchase_returns SET business_id = get_default_business_for_backfill(organization_id)
WHERE business_id IS NULL;

-- Backfill customer_statements
UPDATE customer_statements SET business_id = get_default_business_for_backfill(organization_id)
WHERE business_id IS NULL;

-- Backfill fixed_assets
UPDATE fixed_assets SET business_id = get_default_business_for_backfill(organization_id)
WHERE business_id IS NULL;

-- Backfill warehouses
UPDATE warehouses SET business_id = get_default_business_for_backfill(organization_id)
WHERE business_id IS NULL;

-- Backfill pos_registers
UPDATE pos_registers SET business_id = get_default_business_for_backfill(organization_id)
WHERE business_id IS NULL;

-- Backfill tax_rates
UPDATE tax_rates SET business_id = get_default_business_for_backfill(organization_id)
WHERE business_id IS NULL;

-- Backfill payment_terms
UPDATE payment_terms SET business_id = get_default_business_for_backfill(organization_id)
WHERE business_id IS NULL;

-- Backfill price_lists
UPDATE price_lists SET business_id = get_default_business_for_backfill(organization_id)
WHERE business_id IS NULL;

-- Backfill approval_workflows
UPDATE approval_workflows SET business_id = get_default_business_for_backfill(organization_id)
WHERE business_id IS NULL;

-- Drop the helper function after backfill
DROP FUNCTION IF EXISTS public.get_default_business_for_backfill;