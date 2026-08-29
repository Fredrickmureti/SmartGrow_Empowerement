-- Extend role enum for platform roles used by the app
ALTER TYPE public.app_role ADD VALUE IF NOT EXISTS 'internal';
ALTER TYPE public.app_role ADD VALUE IF NOT EXISTS 'portal';
ALTER TYPE public.app_role ADD VALUE IF NOT EXISTS 'cashier';

-- ============ Enums ============
CREATE TYPE public.contact_type AS ENUM ('customer', 'vendor', 'both');
CREATE TYPE public.product_type AS ENUM ('product', 'service');
CREATE TYPE public.account_type AS ENUM ('asset', 'liability', 'equity', 'income', 'expense');
CREATE TYPE public.invoice_status AS ENUM ('draft', 'sent', 'viewed', 'partial', 'paid', 'overdue', 'cancelled');
CREATE TYPE public.bill_status AS ENUM ('draft', 'open', 'partial', 'paid', 'overdue', 'cancelled');
CREATE TYPE public.payment_direction AS ENUM ('received', 'made');
CREATE TYPE public.journal_status AS ENUM ('draft', 'posted', 'void');

-- ============ Contacts ============
CREATE TABLE public.contacts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  type public.contact_type NOT NULL DEFAULT 'customer',
  name TEXT NOT NULL,
  email TEXT,
  phone TEXT,
  company TEXT,
  address_line1 TEXT,
  address_line2 TEXT,
  city TEXT,
  state TEXT,
  postal_code TEXT,
  country TEXT,
  tax_id TEXT,
  notes TEXT,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.contacts TO authenticated;
GRANT ALL ON public.contacts TO service_role;
ALTER TABLE public.contacts ENABLE ROW LEVEL SECURITY;
CREATE POLICY "contacts_org_access" ON public.contacts FOR ALL TO authenticated
USING (organization_id IN (SELECT public.get_user_organizations(auth.uid())))
WITH CHECK (organization_id IN (SELECT public.get_user_organizations(auth.uid())));
CREATE TRIGGER update_contacts_updated_at BEFORE UPDATE ON public.contacts FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- ============ Products ============
CREATE TABLE public.products (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  type public.product_type NOT NULL DEFAULT 'service',
  name TEXT NOT NULL,
  description TEXT,
  sku TEXT,
  unit_price NUMERIC(15,2) NOT NULL DEFAULT 0,
  cost_price NUMERIC(15,2) NOT NULL DEFAULT 0,
  tax_rate NUMERIC(7,4) NOT NULL DEFAULT 0,
  income_account_id UUID,
  expense_account_id UUID,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.products TO authenticated;
GRANT ALL ON public.products TO service_role;
ALTER TABLE public.products ENABLE ROW LEVEL SECURITY;
CREATE POLICY "products_org_access" ON public.products FOR ALL TO authenticated
USING (organization_id IN (SELECT public.get_user_organizations(auth.uid())))
WITH CHECK (organization_id IN (SELECT public.get_user_organizations(auth.uid())));
CREATE TRIGGER update_products_updated_at BEFORE UPDATE ON public.products FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- ============ Chart of accounts ============
CREATE TABLE public.accounts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  account_type public.account_type NOT NULL,
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  parent_id UUID REFERENCES public.accounts(id) ON DELETE SET NULL,
  is_system BOOLEAN NOT NULL DEFAULT false,
  is_active BOOLEAN NOT NULL DEFAULT true,
  opening_balance NUMERIC(15,2) NOT NULL DEFAULT 0,
  current_balance NUMERIC(15,2) NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (organization_id, code)
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.accounts TO authenticated;
GRANT ALL ON public.accounts TO service_role;
ALTER TABLE public.accounts ENABLE ROW LEVEL SECURITY;
CREATE POLICY "accounts_org_access" ON public.accounts FOR ALL TO authenticated
USING (organization_id IN (SELECT public.get_user_organizations(auth.uid())))
WITH CHECK (organization_id IN (SELECT public.get_user_organizations(auth.uid())));
CREATE TRIGGER update_accounts_updated_at BEFORE UPDATE ON public.accounts FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- ============ Fiscal periods ============
CREATE TABLE public.fiscal_periods (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  start_date DATE NOT NULL,
  end_date DATE NOT NULL,
  is_closed BOOLEAN NOT NULL DEFAULT false,
  closed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.fiscal_periods TO authenticated;
GRANT ALL ON public.fiscal_periods TO service_role;
ALTER TABLE public.fiscal_periods ENABLE ROW LEVEL SECURITY;
CREATE POLICY "fiscal_periods_org_access" ON public.fiscal_periods FOR ALL TO authenticated
USING (organization_id IN (SELECT public.get_user_organizations(auth.uid())))
WITH CHECK (organization_id IN (SELECT public.get_user_organizations(auth.uid())));
CREATE TRIGGER update_fiscal_periods_updated_at BEFORE UPDATE ON public.fiscal_periods FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- ============ Invoices ============
CREATE TABLE public.invoices (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  contact_id UUID REFERENCES public.contacts(id) ON DELETE SET NULL,
  invoice_number TEXT NOT NULL,
  status public.invoice_status NOT NULL DEFAULT 'draft',
  issue_date DATE NOT NULL DEFAULT CURRENT_DATE,
  due_date DATE NOT NULL DEFAULT CURRENT_DATE,
  subtotal NUMERIC(15,2) NOT NULL DEFAULT 0,
  tax_amount NUMERIC(15,2) NOT NULL DEFAULT 0,
  discount_amount NUMERIC(15,2) NOT NULL DEFAULT 0,
  total NUMERIC(15,2) NOT NULL DEFAULT 0,
  amount_paid NUMERIC(15,2) NOT NULL DEFAULT 0,
  currency TEXT NOT NULL DEFAULT 'KES',
  notes TEXT,
  terms TEXT,
  created_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (organization_id, invoice_number)
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.invoices TO authenticated;
GRANT ALL ON public.invoices TO service_role;
ALTER TABLE public.invoices ENABLE ROW LEVEL SECURITY;
CREATE POLICY "invoices_org_access" ON public.invoices FOR ALL TO authenticated
USING (organization_id IN (SELECT public.get_user_organizations(auth.uid())))
WITH CHECK (organization_id IN (SELECT public.get_user_organizations(auth.uid())));
CREATE TRIGGER update_invoices_updated_at BEFORE UPDATE ON public.invoices FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE TABLE public.invoice_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id UUID NOT NULL REFERENCES public.invoices(id) ON DELETE CASCADE,
  product_id UUID REFERENCES public.products(id) ON DELETE SET NULL,
  description TEXT NOT NULL,
  quantity NUMERIC(15,4) NOT NULL DEFAULT 1,
  unit_price NUMERIC(15,2) NOT NULL DEFAULT 0,
  tax_rate NUMERIC(7,4) NOT NULL DEFAULT 0,
  tax_amount NUMERIC(15,2) NOT NULL DEFAULT 0,
  discount_percent NUMERIC(7,4) NOT NULL DEFAULT 0,
  line_total NUMERIC(15,2) NOT NULL DEFAULT 0,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.invoice_items TO authenticated;
GRANT ALL ON public.invoice_items TO service_role;
ALTER TABLE public.invoice_items ENABLE ROW LEVEL SECURITY;
CREATE POLICY "invoice_items_via_invoice" ON public.invoice_items FOR ALL TO authenticated
USING (invoice_id IN (SELECT id FROM public.invoices WHERE organization_id IN (SELECT public.get_user_organizations(auth.uid()))))
WITH CHECK (invoice_id IN (SELECT id FROM public.invoices WHERE organization_id IN (SELECT public.get_user_organizations(auth.uid()))));

-- ============ Bills ============
CREATE TABLE public.bills (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  vendor_id UUID REFERENCES public.contacts(id) ON DELETE SET NULL,
  bill_number TEXT NOT NULL,
  status public.bill_status NOT NULL DEFAULT 'draft',
  issue_date DATE NOT NULL DEFAULT CURRENT_DATE,
  due_date DATE NOT NULL DEFAULT CURRENT_DATE,
  subtotal NUMERIC(15,2) NOT NULL DEFAULT 0,
  tax_amount NUMERIC(15,2) NOT NULL DEFAULT 0,
  total NUMERIC(15,2) NOT NULL DEFAULT 0,
  amount_paid NUMERIC(15,2) NOT NULL DEFAULT 0,
  currency TEXT NOT NULL DEFAULT 'KES',
  notes TEXT,
  created_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (organization_id, bill_number)
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.bills TO authenticated;
GRANT ALL ON public.bills TO service_role;
ALTER TABLE public.bills ENABLE ROW LEVEL SECURITY;
CREATE POLICY "bills_org_access" ON public.bills FOR ALL TO authenticated
USING (organization_id IN (SELECT public.get_user_organizations(auth.uid())))
WITH CHECK (organization_id IN (SELECT public.get_user_organizations(auth.uid())));
CREATE TRIGGER update_bills_updated_at BEFORE UPDATE ON public.bills FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE TABLE public.bill_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  bill_id UUID NOT NULL REFERENCES public.bills(id) ON DELETE CASCADE,
  account_id UUID REFERENCES public.accounts(id) ON DELETE SET NULL,
  description TEXT NOT NULL,
  quantity NUMERIC(15,4) NOT NULL DEFAULT 1,
  unit_price NUMERIC(15,2) NOT NULL DEFAULT 0,
  tax_rate NUMERIC(7,4) NOT NULL DEFAULT 0,
  tax_amount NUMERIC(15,2) NOT NULL DEFAULT 0,
  line_total NUMERIC(15,2) NOT NULL DEFAULT 0,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.bill_items TO authenticated;
GRANT ALL ON public.bill_items TO service_role;
ALTER TABLE public.bill_items ENABLE ROW LEVEL SECURITY;
CREATE POLICY "bill_items_via_bill" ON public.bill_items FOR ALL TO authenticated
USING (bill_id IN (SELECT id FROM public.bills WHERE organization_id IN (SELECT public.get_user_organizations(auth.uid()))))
WITH CHECK (bill_id IN (SELECT id FROM public.bills WHERE organization_id IN (SELECT public.get_user_organizations(auth.uid()))));

-- ============ Bank accounts ============
CREATE TABLE public.bank_accounts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  account_id UUID REFERENCES public.accounts(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  bank_name TEXT,
  account_number TEXT,
  currency TEXT NOT NULL DEFAULT 'KES',
  opening_balance NUMERIC(15,2) NOT NULL DEFAULT 0,
  current_balance NUMERIC(15,2) NOT NULL DEFAULT 0,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.bank_accounts TO authenticated;
GRANT ALL ON public.bank_accounts TO service_role;
ALTER TABLE public.bank_accounts ENABLE ROW LEVEL SECURITY;
CREATE POLICY "bank_accounts_org_access" ON public.bank_accounts FOR ALL TO authenticated
USING (organization_id IN (SELECT public.get_user_organizations(auth.uid())))
WITH CHECK (organization_id IN (SELECT public.get_user_organizations(auth.uid())));
CREATE TRIGGER update_bank_accounts_updated_at BEFORE UPDATE ON public.bank_accounts FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- ============ Payments ============
CREATE TABLE public.payments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  direction public.payment_direction NOT NULL DEFAULT 'received',
  contact_id UUID REFERENCES public.contacts(id) ON DELETE SET NULL,
  invoice_id UUID REFERENCES public.invoices(id) ON DELETE SET NULL,
  bill_id UUID REFERENCES public.bills(id) ON DELETE SET NULL,
  bank_account_id UUID REFERENCES public.bank_accounts(id) ON DELETE SET NULL,
  payment_date DATE NOT NULL DEFAULT CURRENT_DATE,
  amount NUMERIC(15,2) NOT NULL DEFAULT 0,
  currency TEXT NOT NULL DEFAULT 'KES',
  method TEXT,
  reference TEXT,
  notes TEXT,
  created_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.payments TO authenticated;
GRANT ALL ON public.payments TO service_role;
ALTER TABLE public.payments ENABLE ROW LEVEL SECURITY;
CREATE POLICY "payments_org_access" ON public.payments FOR ALL TO authenticated
USING (organization_id IN (SELECT public.get_user_organizations(auth.uid())))
WITH CHECK (organization_id IN (SELECT public.get_user_organizations(auth.uid())));
CREATE TRIGGER update_payments_updated_at BEFORE UPDATE ON public.payments FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- ============ Journal entries ============
CREATE TABLE public.journal_entries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  entry_number TEXT NOT NULL,
  entry_date DATE NOT NULL DEFAULT CURRENT_DATE,
  status public.journal_status NOT NULL DEFAULT 'draft',
  description TEXT,
  reference TEXT,
  source_module TEXT,
  source_doc_type TEXT,
  source_doc_id UUID,
  fiscal_period_id UUID REFERENCES public.fiscal_periods(id) ON DELETE SET NULL,
  currency TEXT NOT NULL DEFAULT 'KES',
  posted_at TIMESTAMPTZ,
  created_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (organization_id, entry_number)
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.journal_entries TO authenticated;
GRANT ALL ON public.journal_entries TO service_role;
ALTER TABLE public.journal_entries ENABLE ROW LEVEL SECURITY;
CREATE POLICY "journal_entries_org_access" ON public.journal_entries FOR ALL TO authenticated
USING (organization_id IN (SELECT public.get_user_organizations(auth.uid())))
WITH CHECK (organization_id IN (SELECT public.get_user_organizations(auth.uid())));
CREATE TRIGGER update_journal_entries_updated_at BEFORE UPDATE ON public.journal_entries FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE TABLE public.journal_entry_lines (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  journal_entry_id UUID NOT NULL REFERENCES public.journal_entries(id) ON DELETE CASCADE,
  account_id UUID NOT NULL REFERENCES public.accounts(id) ON DELETE RESTRICT,
  contact_id UUID REFERENCES public.contacts(id) ON DELETE SET NULL,
  description TEXT,
  debit NUMERIC(15,2) NOT NULL DEFAULT 0,
  credit NUMERIC(15,2) NOT NULL DEFAULT 0,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.journal_entry_lines TO authenticated;
GRANT ALL ON public.journal_entry_lines TO service_role;
ALTER TABLE public.journal_entry_lines ENABLE ROW LEVEL SECURITY;
CREATE POLICY "journal_entry_lines_via_entry" ON public.journal_entry_lines FOR ALL TO authenticated
USING (journal_entry_id IN (SELECT id FROM public.journal_entries WHERE organization_id IN (SELECT public.get_user_organizations(auth.uid()))))
WITH CHECK (journal_entry_id IN (SELECT id FROM public.journal_entries WHERE organization_id IN (SELECT public.get_user_organizations(auth.uid()))));

-- ============ Currencies, FX, tax ============
CREATE TABLE public.currencies (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  symbol TEXT,
  decimal_places INTEGER NOT NULL DEFAULT 2,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (organization_id, code)
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.currencies TO authenticated;
GRANT ALL ON public.currencies TO service_role;
ALTER TABLE public.currencies ENABLE ROW LEVEL SECURITY;
CREATE POLICY "currencies_org_access" ON public.currencies FOR ALL TO authenticated
USING (organization_id IN (SELECT public.get_user_organizations(auth.uid())))
WITH CHECK (organization_id IN (SELECT public.get_user_organizations(auth.uid())));
CREATE TRIGGER update_currencies_updated_at BEFORE UPDATE ON public.currencies FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE TABLE public.exchange_rates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  from_currency TEXT NOT NULL,
  to_currency TEXT NOT NULL,
  rate NUMERIC(20,10) NOT NULL,
  rate_date DATE NOT NULL DEFAULT CURRENT_DATE,
  source TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (organization_id, from_currency, to_currency, rate_date)
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.exchange_rates TO authenticated;
GRANT ALL ON public.exchange_rates TO service_role;
ALTER TABLE public.exchange_rates ENABLE ROW LEVEL SECURITY;
CREATE POLICY "exchange_rates_org_access" ON public.exchange_rates FOR ALL TO authenticated
USING (organization_id IN (SELECT public.get_user_organizations(auth.uid())))
WITH CHECK (organization_id IN (SELECT public.get_user_organizations(auth.uid())));
CREATE TRIGGER update_exchange_rates_updated_at BEFORE UPDATE ON public.exchange_rates FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE TABLE public.tax_rates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  rate NUMERIC(7,4) NOT NULL DEFAULT 0,
  is_compound BOOLEAN NOT NULL DEFAULT false,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.tax_rates TO authenticated;
GRANT ALL ON public.tax_rates TO service_role;
ALTER TABLE public.tax_rates ENABLE ROW LEVEL SECURITY;
CREATE POLICY "tax_rates_org_access" ON public.tax_rates FOR ALL TO authenticated
USING (organization_id IN (SELECT public.get_user_organizations(auth.uid())))
WITH CHECK (organization_id IN (SELECT public.get_user_organizations(auth.uid())));
CREATE TRIGGER update_tax_rates_updated_at BEFORE UPDATE ON public.tax_rates FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE TABLE public.tax_groups (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.tax_groups TO authenticated;
GRANT ALL ON public.tax_groups TO service_role;
ALTER TABLE public.tax_groups ENABLE ROW LEVEL SECURITY;
CREATE POLICY "tax_groups_org_access" ON public.tax_groups FOR ALL TO authenticated
USING (organization_id IN (SELECT public.get_user_organizations(auth.uid())))
WITH CHECK (organization_id IN (SELECT public.get_user_organizations(auth.uid())));
CREATE TRIGGER update_tax_groups_updated_at BEFORE UPDATE ON public.tax_groups FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE TABLE public.tax_group_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tax_group_id UUID NOT NULL REFERENCES public.tax_groups(id) ON DELETE CASCADE,
  tax_rate_id UUID NOT NULL REFERENCES public.tax_rates(id) ON DELETE CASCADE,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tax_group_id, tax_rate_id)
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.tax_group_items TO authenticated;
GRANT ALL ON public.tax_group_items TO service_role;
ALTER TABLE public.tax_group_items ENABLE ROW LEVEL SECURITY;
CREATE POLICY "tax_group_items_via_group" ON public.tax_group_items FOR ALL TO authenticated
USING (tax_group_id IN (SELECT id FROM public.tax_groups WHERE organization_id IN (SELECT public.get_user_organizations(auth.uid()))))
WITH CHECK (tax_group_id IN (SELECT id FROM public.tax_groups WHERE organization_id IN (SELECT public.get_user_organizations(auth.uid()))));

-- Helpful indexes
CREATE INDEX idx_invoices_org_status ON public.invoices(organization_id, status);
CREATE INDEX idx_bills_org_status ON public.bills(organization_id, status);
CREATE INDEX idx_je_org_date ON public.journal_entries(organization_id, entry_date);
CREATE INDEX idx_jel_entry ON public.journal_entry_lines(journal_entry_id);
CREATE INDEX idx_jel_account ON public.journal_entry_lines(account_id);
CREATE INDEX idx_payments_org_date ON public.payments(organization_id, payment_date);