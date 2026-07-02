-- =============================================
-- CONTACTS (Customers & Vendors)
-- =============================================
CREATE TYPE public.contact_type AS ENUM ('customer', 'vendor', 'both');

CREATE TABLE public.contacts (
    id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
    organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
    type contact_type NOT NULL DEFAULT 'customer',
    name TEXT NOT NULL,
    email TEXT,
    phone TEXT,
    company TEXT,
    address_line1 TEXT,
    address_line2 TEXT,
    city TEXT,
    state TEXT,
    postal_code TEXT,
    country TEXT DEFAULT 'US',
    tax_id TEXT,
    notes TEXT,
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.contacts ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view contacts in their organizations"
ON public.contacts FOR SELECT
USING (organization_id IN (SELECT get_user_organizations(auth.uid())));

CREATE POLICY "Users can create contacts in their organizations"
ON public.contacts FOR INSERT
WITH CHECK (organization_id IN (SELECT get_user_organizations(auth.uid())));

CREATE POLICY "Users can update contacts in their organizations"
ON public.contacts FOR UPDATE
USING (organization_id IN (SELECT get_user_organizations(auth.uid())));

CREATE POLICY "Users can delete contacts in their organizations"
ON public.contacts FOR DELETE
USING (organization_id IN (SELECT get_user_organizations(auth.uid())));

CREATE TRIGGER update_contacts_updated_at
BEFORE UPDATE ON public.contacts
FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- =============================================
-- PRODUCTS & SERVICES
-- =============================================
CREATE TYPE public.product_type AS ENUM ('product', 'service');

CREATE TABLE public.products (
    id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
    organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
    type product_type NOT NULL DEFAULT 'service',
    name TEXT NOT NULL,
    description TEXT,
    sku TEXT,
    unit_price DECIMAL(15, 2) NOT NULL DEFAULT 0,
    cost_price DECIMAL(15, 2) DEFAULT 0,
    tax_rate DECIMAL(5, 2) DEFAULT 0,
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.products ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view products in their organizations"
ON public.products FOR SELECT
USING (organization_id IN (SELECT get_user_organizations(auth.uid())));

CREATE POLICY "Users can create products in their organizations"
ON public.products FOR INSERT
WITH CHECK (organization_id IN (SELECT get_user_organizations(auth.uid())));

CREATE POLICY "Users can update products in their organizations"
ON public.products FOR UPDATE
USING (organization_id IN (SELECT get_user_organizations(auth.uid())));

CREATE POLICY "Users can delete products in their organizations"
ON public.products FOR DELETE
USING (organization_id IN (SELECT get_user_organizations(auth.uid())));

CREATE TRIGGER update_products_updated_at
BEFORE UPDATE ON public.products
FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- =============================================
-- CHART OF ACCOUNTS
-- =============================================
CREATE TYPE public.account_type AS ENUM (
    'asset', 'liability', 'equity', 'income', 'expense'
);

CREATE TABLE public.accounts (
    id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
    organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
    account_type account_type NOT NULL,
    code TEXT NOT NULL,
    name TEXT NOT NULL,
    description TEXT,
    parent_id UUID REFERENCES public.accounts(id),
    is_system BOOLEAN DEFAULT false,
    is_active BOOLEAN DEFAULT true,
    opening_balance DECIMAL(15, 2) DEFAULT 0,
    current_balance DECIMAL(15, 2) DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE(organization_id, code)
);

ALTER TABLE public.accounts ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view accounts in their organizations"
ON public.accounts FOR SELECT
USING (organization_id IN (SELECT get_user_organizations(auth.uid())));

CREATE POLICY "Users can create accounts in their organizations"
ON public.accounts FOR INSERT
WITH CHECK (organization_id IN (SELECT get_user_organizations(auth.uid())));

CREATE POLICY "Users can update accounts in their organizations"
ON public.accounts FOR UPDATE
USING (organization_id IN (SELECT get_user_organizations(auth.uid())));

CREATE POLICY "Users can delete non-system accounts"
ON public.accounts FOR DELETE
USING (organization_id IN (SELECT get_user_organizations(auth.uid())) AND is_system = false);

CREATE TRIGGER update_accounts_updated_at
BEFORE UPDATE ON public.accounts
FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- =============================================
-- INVOICES
-- =============================================
CREATE TYPE public.invoice_status AS ENUM (
    'draft', 'sent', 'viewed', 'partial', 'paid', 'overdue', 'cancelled'
);

CREATE TABLE public.invoices (
    id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
    organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
    contact_id UUID REFERENCES public.contacts(id) ON DELETE SET NULL,
    invoice_number TEXT NOT NULL,
    status invoice_status NOT NULL DEFAULT 'draft',
    issue_date DATE NOT NULL DEFAULT CURRENT_DATE,
    due_date DATE NOT NULL,
    subtotal DECIMAL(15, 2) NOT NULL DEFAULT 0,
    tax_amount DECIMAL(15, 2) NOT NULL DEFAULT 0,
    discount_amount DECIMAL(15, 2) DEFAULT 0,
    total DECIMAL(15, 2) NOT NULL DEFAULT 0,
    amount_paid DECIMAL(15, 2) DEFAULT 0,
    currency TEXT DEFAULT 'USD',
    notes TEXT,
    terms TEXT,
    created_by UUID REFERENCES auth.users(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE(organization_id, invoice_number)
);

ALTER TABLE public.invoices ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view invoices in their organizations"
ON public.invoices FOR SELECT
USING (organization_id IN (SELECT get_user_organizations(auth.uid())));

CREATE POLICY "Users can create invoices in their organizations"
ON public.invoices FOR INSERT
WITH CHECK (organization_id IN (SELECT get_user_organizations(auth.uid())));

CREATE POLICY "Users can update invoices in their organizations"
ON public.invoices FOR UPDATE
USING (organization_id IN (SELECT get_user_organizations(auth.uid())));

CREATE POLICY "Users can delete draft invoices"
ON public.invoices FOR DELETE
USING (organization_id IN (SELECT get_user_organizations(auth.uid())) AND status = 'draft');

CREATE TRIGGER update_invoices_updated_at
BEFORE UPDATE ON public.invoices
FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- =============================================
-- INVOICE LINE ITEMS
-- =============================================
CREATE TABLE public.invoice_items (
    id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
    invoice_id UUID NOT NULL REFERENCES public.invoices(id) ON DELETE CASCADE,
    product_id UUID REFERENCES public.products(id) ON DELETE SET NULL,
    description TEXT NOT NULL,
    quantity DECIMAL(10, 2) NOT NULL DEFAULT 1,
    unit_price DECIMAL(15, 2) NOT NULL,
    tax_rate DECIMAL(5, 2) DEFAULT 0,
    tax_amount DECIMAL(15, 2) DEFAULT 0,
    discount_percent DECIMAL(5, 2) DEFAULT 0,
    line_total DECIMAL(15, 2) NOT NULL,
    sort_order INTEGER DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.invoice_items ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view invoice items via invoice"
ON public.invoice_items FOR SELECT
USING (invoice_id IN (
    SELECT id FROM public.invoices 
    WHERE organization_id IN (SELECT get_user_organizations(auth.uid()))
));

CREATE POLICY "Users can create invoice items via invoice"
ON public.invoice_items FOR INSERT
WITH CHECK (invoice_id IN (
    SELECT id FROM public.invoices 
    WHERE organization_id IN (SELECT get_user_organizations(auth.uid()))
));

CREATE POLICY "Users can update invoice items via invoice"
ON public.invoice_items FOR UPDATE
USING (invoice_id IN (
    SELECT id FROM public.invoices 
    WHERE organization_id IN (SELECT get_user_organizations(auth.uid()))
));

CREATE POLICY "Users can delete invoice items via invoice"
ON public.invoice_items FOR DELETE
USING (invoice_id IN (
    SELECT id FROM public.invoices 
    WHERE organization_id IN (SELECT get_user_organizations(auth.uid()))
));

-- =============================================
-- EXPENSES
-- =============================================
CREATE TYPE public.expense_status AS ENUM (
    'pending', 'approved', 'rejected', 'paid'
);

CREATE TABLE public.expense_categories (
    id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
    organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    description TEXT,
    color TEXT DEFAULT '#6366f1',
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.expense_categories ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view expense categories in their organizations"
ON public.expense_categories FOR SELECT
USING (organization_id IN (SELECT get_user_organizations(auth.uid())));

CREATE POLICY "Users can create expense categories"
ON public.expense_categories FOR INSERT
WITH CHECK (organization_id IN (SELECT get_user_organizations(auth.uid())));

CREATE POLICY "Users can update expense categories"
ON public.expense_categories FOR UPDATE
USING (organization_id IN (SELECT get_user_organizations(auth.uid())));

CREATE POLICY "Users can delete expense categories"
ON public.expense_categories FOR DELETE
USING (organization_id IN (SELECT get_user_organizations(auth.uid())));

CREATE TABLE public.expenses (
    id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
    organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
    category_id UUID REFERENCES public.expense_categories(id) ON DELETE SET NULL,
    vendor_id UUID REFERENCES public.contacts(id) ON DELETE SET NULL,
    account_id UUID REFERENCES public.accounts(id) ON DELETE SET NULL,
    expense_date DATE NOT NULL DEFAULT CURRENT_DATE,
    amount DECIMAL(15, 2) NOT NULL,
    tax_amount DECIMAL(15, 2) DEFAULT 0,
    currency TEXT DEFAULT 'USD',
    description TEXT NOT NULL,
    reference TEXT,
    receipt_url TEXT,
    status expense_status NOT NULL DEFAULT 'pending',
    is_billable BOOLEAN DEFAULT false,
    created_by UUID REFERENCES auth.users(id),
    approved_by UUID REFERENCES auth.users(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.expenses ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view expenses in their organizations"
ON public.expenses FOR SELECT
USING (organization_id IN (SELECT get_user_organizations(auth.uid())));

CREATE POLICY "Users can create expenses in their organizations"
ON public.expenses FOR INSERT
WITH CHECK (organization_id IN (SELECT get_user_organizations(auth.uid())));

CREATE POLICY "Users can update expenses in their organizations"
ON public.expenses FOR UPDATE
USING (organization_id IN (SELECT get_user_organizations(auth.uid())));

CREATE POLICY "Users can delete pending expenses"
ON public.expenses FOR DELETE
USING (organization_id IN (SELECT get_user_organizations(auth.uid())) AND status = 'pending');

CREATE TRIGGER update_expenses_updated_at
BEFORE UPDATE ON public.expenses
FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- =============================================
-- PAYMENTS
-- =============================================
CREATE TYPE public.payment_method AS ENUM (
    'cash', 'bank_transfer', 'credit_card', 'check', 'other'
);

CREATE TABLE public.payments (
    id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
    organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
    invoice_id UUID REFERENCES public.invoices(id) ON DELETE SET NULL,
    contact_id UUID REFERENCES public.contacts(id) ON DELETE SET NULL,
    amount DECIMAL(15, 2) NOT NULL,
    payment_date DATE NOT NULL DEFAULT CURRENT_DATE,
    payment_method payment_method NOT NULL DEFAULT 'bank_transfer',
    reference TEXT,
    notes TEXT,
    created_by UUID REFERENCES auth.users(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.payments ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view payments in their organizations"
ON public.payments FOR SELECT
USING (organization_id IN (SELECT get_user_organizations(auth.uid())));

CREATE POLICY "Users can create payments in their organizations"
ON public.payments FOR INSERT
WITH CHECK (organization_id IN (SELECT get_user_organizations(auth.uid())));

CREATE POLICY "Users can update payments in their organizations"
ON public.payments FOR UPDATE
USING (organization_id IN (SELECT get_user_organizations(auth.uid())));

-- =============================================
-- TRANSACTIONS / JOURNAL ENTRIES
-- =============================================
CREATE TYPE public.transaction_type AS ENUM (
    'invoice', 'payment', 'expense', 'transfer', 'adjustment', 'opening_balance'
);

CREATE TABLE public.transactions (
    id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
    organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
    transaction_type transaction_type NOT NULL,
    transaction_date DATE NOT NULL DEFAULT CURRENT_DATE,
    reference TEXT,
    description TEXT,
    invoice_id UUID REFERENCES public.invoices(id) ON DELETE SET NULL,
    expense_id UUID REFERENCES public.expenses(id) ON DELETE SET NULL,
    payment_id UUID REFERENCES public.payments(id) ON DELETE SET NULL,
    is_reconciled BOOLEAN DEFAULT false,
    created_by UUID REFERENCES auth.users(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.transactions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view transactions in their organizations"
ON public.transactions FOR SELECT
USING (organization_id IN (SELECT get_user_organizations(auth.uid())));

CREATE POLICY "Users can create transactions in their organizations"
ON public.transactions FOR INSERT
WITH CHECK (organization_id IN (SELECT get_user_organizations(auth.uid())));

CREATE POLICY "Users can update transactions in their organizations"
ON public.transactions FOR UPDATE
USING (organization_id IN (SELECT get_user_organizations(auth.uid())));

-- Transaction line items (double-entry accounting)
CREATE TABLE public.transaction_lines (
    id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
    transaction_id UUID NOT NULL REFERENCES public.transactions(id) ON DELETE CASCADE,
    account_id UUID NOT NULL REFERENCES public.accounts(id) ON DELETE RESTRICT,
    debit DECIMAL(15, 2) DEFAULT 0,
    credit DECIMAL(15, 2) DEFAULT 0,
    description TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.transaction_lines ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view transaction lines via transaction"
ON public.transaction_lines FOR SELECT
USING (transaction_id IN (
    SELECT id FROM public.transactions 
    WHERE organization_id IN (SELECT get_user_organizations(auth.uid()))
));

CREATE POLICY "Users can create transaction lines via transaction"
ON public.transaction_lines FOR INSERT
WITH CHECK (transaction_id IN (
    SELECT id FROM public.transactions 
    WHERE organization_id IN (SELECT get_user_organizations(auth.uid()))
));

CREATE POLICY "Users can update transaction lines via transaction"
ON public.transaction_lines FOR UPDATE
USING (transaction_id IN (
    SELECT id FROM public.transactions 
    WHERE organization_id IN (SELECT get_user_organizations(auth.uid()))
));

-- =============================================
-- BANK ACCOUNTS
-- =============================================
CREATE TABLE public.bank_accounts (
    id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
    organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
    account_id UUID REFERENCES public.accounts(id) ON DELETE SET NULL,
    name TEXT NOT NULL,
    bank_name TEXT,
    account_number TEXT,
    routing_number TEXT,
    currency TEXT DEFAULT 'USD',
    current_balance DECIMAL(15, 2) DEFAULT 0,
    is_primary BOOLEAN DEFAULT false,
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.bank_accounts ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view bank accounts in their organizations"
ON public.bank_accounts FOR SELECT
USING (organization_id IN (SELECT get_user_organizations(auth.uid())));

CREATE POLICY "Admins can manage bank accounts"
ON public.bank_accounts FOR ALL
USING (
    has_role(auth.uid(), organization_id, 'owner') OR 
    has_role(auth.uid(), organization_id, 'admin') OR
    has_role(auth.uid(), organization_id, 'accountant')
);

CREATE TRIGGER update_bank_accounts_updated_at
BEFORE UPDATE ON public.bank_accounts
FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- =============================================
-- HELPER FUNCTION: Generate next invoice number
-- =============================================
CREATE OR REPLACE FUNCTION public.get_next_invoice_number(_org_id uuid)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    next_num INTEGER;
    year_prefix TEXT;
BEGIN
    year_prefix := to_char(CURRENT_DATE, 'YYYY');
    
    SELECT COALESCE(MAX(
        CAST(NULLIF(regexp_replace(invoice_number, '[^0-9]', '', 'g'), '') AS INTEGER)
    ), 0) + 1
    INTO next_num
    FROM public.invoices
    WHERE organization_id = _org_id
    AND invoice_number LIKE 'INV-' || year_prefix || '-%';
    
    RETURN 'INV-' || year_prefix || '-' || LPAD(next_num::TEXT, 4, '0');
END;
$$;