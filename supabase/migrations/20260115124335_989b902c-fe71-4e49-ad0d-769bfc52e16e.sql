-- POS System Database Schema
-- Phase 1: Foundation Tables

-- 1. POS Registers - Terminal/Register Management
CREATE TABLE public.pos_registers (
    id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
    organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
    branch_id UUID REFERENCES public.branches(id) ON DELETE SET NULL,
    register_name TEXT NOT NULL,
    register_code TEXT NOT NULL,
    is_active BOOLEAN DEFAULT true,
    last_active_at TIMESTAMP WITH TIME ZONE,
    default_payment_methods JSONB DEFAULT '["cash", "card"]'::jsonb,
    receipt_header TEXT,
    receipt_footer TEXT,
    settings JSONB DEFAULT '{}'::jsonb,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
    UNIQUE(organization_id, register_code)
);

-- 2. POS Shifts - Session Management
CREATE TABLE public.pos_shifts (
    id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
    organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
    branch_id UUID REFERENCES public.branches(id) ON DELETE SET NULL,
    register_id UUID NOT NULL REFERENCES public.pos_registers(id) ON DELETE CASCADE,
    user_id UUID NOT NULL,
    shift_number TEXT NOT NULL,
    opened_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
    closed_at TIMESTAMP WITH TIME ZONE,
    opening_cash NUMERIC(15,2) DEFAULT 0,
    expected_cash NUMERIC(15,2) DEFAULT 0,
    actual_cash NUMERIC(15,2),
    cash_difference NUMERIC(15,2),
    status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed', 'reconciled')),
    notes TEXT,
    closed_by UUID,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- 3. POS Transactions - Sales Transactions
CREATE TABLE public.pos_transactions (
    id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
    organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
    branch_id UUID REFERENCES public.branches(id) ON DELETE SET NULL,
    register_id UUID NOT NULL REFERENCES public.pos_registers(id) ON DELETE CASCADE,
    shift_id UUID NOT NULL REFERENCES public.pos_shifts(id) ON DELETE CASCADE,
    transaction_number TEXT NOT NULL,
    transaction_type TEXT NOT NULL DEFAULT 'sale' CHECK (transaction_type IN ('sale', 'return', 'exchange')),
    customer_id UUID REFERENCES public.contacts(id) ON DELETE SET NULL,
    customer_name TEXT,
    subtotal NUMERIC(15,2) NOT NULL DEFAULT 0,
    tax_amount NUMERIC(15,2) NOT NULL DEFAULT 0,
    discount_amount NUMERIC(15,2) DEFAULT 0,
    total NUMERIC(15,2) NOT NULL DEFAULT 0,
    payment_status TEXT NOT NULL DEFAULT 'pending' CHECK (payment_status IN ('pending', 'paid', 'partial', 'refunded')),
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'completed', 'voided', 'suspended')),
    completed_at TIMESTAMP WITH TIME ZONE,
    created_by UUID,
    synced_to_accounting BOOLEAN DEFAULT false,
    invoice_id UUID REFERENCES public.invoices(id) ON DELETE SET NULL,
    notes TEXT,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
    UNIQUE(organization_id, transaction_number)
);

-- 4. POS Transaction Items - Line Items
CREATE TABLE public.pos_transaction_items (
    id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
    transaction_id UUID NOT NULL REFERENCES public.pos_transactions(id) ON DELETE CASCADE,
    product_id UUID REFERENCES public.products(id) ON DELETE SET NULL,
    description TEXT NOT NULL,
    quantity NUMERIC(15,3) NOT NULL DEFAULT 1,
    unit_price NUMERIC(15,2) NOT NULL,
    discount_type TEXT CHECK (discount_type IN ('percent', 'fixed')),
    discount_value NUMERIC(15,2) DEFAULT 0,
    tax_rate NUMERIC(5,2) DEFAULT 0,
    tax_amount NUMERIC(15,2) DEFAULT 0,
    line_total NUMERIC(15,2) NOT NULL,
    cost_price NUMERIC(15,2),
    sort_order INTEGER DEFAULT 0,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- 5. POS Transaction Payments - Split Payment Support
CREATE TABLE public.pos_transaction_payments (
    id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
    transaction_id UUID NOT NULL REFERENCES public.pos_transactions(id) ON DELETE CASCADE,
    payment_method TEXT NOT NULL CHECK (payment_method IN ('cash', 'card', 'mobile_money', 'voucher', 'credit', 'bank_transfer', 'other')),
    amount NUMERIC(15,2) NOT NULL,
    reference TEXT,
    card_last_four TEXT,
    card_type TEXT,
    processed_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
    status TEXT NOT NULL DEFAULT 'completed' CHECK (status IN ('pending', 'completed', 'failed', 'refunded')),
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- 6. POS Cash Movements - Cash Drawer Operations
CREATE TABLE public.pos_cash_movements (
    id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
    organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
    shift_id UUID NOT NULL REFERENCES public.pos_shifts(id) ON DELETE CASCADE,
    register_id UUID NOT NULL REFERENCES public.pos_registers(id) ON DELETE CASCADE,
    movement_type TEXT NOT NULL CHECK (movement_type IN ('cash_in', 'cash_out', 'float', 'pickup', 'drop')),
    amount NUMERIC(15,2) NOT NULL,
    reason TEXT,
    notes TEXT,
    performed_by UUID,
    performed_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- 7. POS Held Transactions - Parked/Suspended Sales
CREATE TABLE public.pos_held_transactions (
    id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
    organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
    register_id UUID NOT NULL REFERENCES public.pos_registers(id) ON DELETE CASCADE,
    shift_id UUID NOT NULL REFERENCES public.pos_shifts(id) ON DELETE CASCADE,
    customer_name TEXT,
    customer_id UUID REFERENCES public.contacts(id) ON DELETE SET NULL,
    items JSONB NOT NULL DEFAULT '[]'::jsonb,
    subtotal NUMERIC(15,2) DEFAULT 0,
    held_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
    held_by UUID,
    notes TEXT,
    status TEXT NOT NULL DEFAULT 'held' CHECK (status IN ('held', 'resumed', 'cancelled')),
    resumed_transaction_id UUID REFERENCES public.pos_transactions(id) ON DELETE SET NULL,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- 8. POS Discounts - Discount Configurations
CREATE TABLE public.pos_discounts (
    id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
    organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    discount_type TEXT NOT NULL CHECK (discount_type IN ('percentage', 'fixed')),
    value NUMERIC(15,2) NOT NULL,
    min_purchase_amount NUMERIC(15,2) DEFAULT 0,
    requires_approval BOOLEAN DEFAULT false,
    approval_role TEXT,
    valid_from TIMESTAMP WITH TIME ZONE,
    valid_to TIMESTAMP WITH TIME ZONE,
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- 9. POS GL Mappings - Accounting Integration Configuration
CREATE TABLE public.pos_gl_mappings (
    id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
    organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
    transaction_type TEXT NOT NULL CHECK (transaction_type IN ('sale', 'return', 'discount', 'tax')),
    payment_method TEXT,
    debit_account_id UUID REFERENCES public.accounts(id) ON DELETE SET NULL,
    credit_account_id UUID REFERENCES public.accounts(id) ON DELETE SET NULL,
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
    UNIQUE(organization_id, transaction_type, payment_method)
);

-- Create indexes for performance
CREATE INDEX idx_pos_registers_org ON public.pos_registers(organization_id);
CREATE INDEX idx_pos_registers_branch ON public.pos_registers(branch_id);
CREATE INDEX idx_pos_shifts_register ON public.pos_shifts(register_id);
CREATE INDEX idx_pos_shifts_user ON public.pos_shifts(user_id);
CREATE INDEX idx_pos_shifts_status ON public.pos_shifts(status);
CREATE INDEX idx_pos_transactions_shift ON public.pos_transactions(shift_id);
CREATE INDEX idx_pos_transactions_customer ON public.pos_transactions(customer_id);
CREATE INDEX idx_pos_transactions_status ON public.pos_transactions(status);
CREATE INDEX idx_pos_transactions_date ON public.pos_transactions(created_at);
CREATE INDEX idx_pos_transaction_items_product ON public.pos_transaction_items(product_id);
CREATE INDEX idx_pos_cash_movements_shift ON public.pos_cash_movements(shift_id);
CREATE INDEX idx_pos_held_transactions_status ON public.pos_held_transactions(status);

-- Enable RLS on all tables
ALTER TABLE public.pos_registers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pos_shifts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pos_transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pos_transaction_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pos_transaction_payments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pos_cash_movements ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pos_held_transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pos_discounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pos_gl_mappings ENABLE ROW LEVEL SECURITY;

-- RLS Policies for pos_registers
CREATE POLICY "Users can view registers in their organization"
    ON public.pos_registers FOR SELECT
    USING (public.is_org_member(auth.uid(), organization_id));

CREATE POLICY "Users can manage registers in their organization"
    ON public.pos_registers FOR ALL
    USING (public.is_org_member(auth.uid(), organization_id));

-- RLS Policies for pos_shifts
CREATE POLICY "Users can view shifts in their organization"
    ON public.pos_shifts FOR SELECT
    USING (public.is_org_member(auth.uid(), organization_id));

CREATE POLICY "Users can manage shifts in their organization"
    ON public.pos_shifts FOR ALL
    USING (public.is_org_member(auth.uid(), organization_id));

-- RLS Policies for pos_transactions
CREATE POLICY "Users can view transactions in their organization"
    ON public.pos_transactions FOR SELECT
    USING (public.is_org_member(auth.uid(), organization_id));

CREATE POLICY "Users can manage transactions in their organization"
    ON public.pos_transactions FOR ALL
    USING (public.is_org_member(auth.uid(), organization_id));

-- RLS Policies for pos_transaction_items
CREATE POLICY "Users can view transaction items via transaction"
    ON public.pos_transaction_items FOR SELECT
    USING (EXISTS (
        SELECT 1 FROM public.pos_transactions t 
        WHERE t.id = transaction_id 
        AND public.is_org_member(auth.uid(), t.organization_id)
    ));

CREATE POLICY "Users can manage transaction items via transaction"
    ON public.pos_transaction_items FOR ALL
    USING (EXISTS (
        SELECT 1 FROM public.pos_transactions t 
        WHERE t.id = transaction_id 
        AND public.is_org_member(auth.uid(), t.organization_id)
    ));

-- RLS Policies for pos_transaction_payments
CREATE POLICY "Users can view transaction payments via transaction"
    ON public.pos_transaction_payments FOR SELECT
    USING (EXISTS (
        SELECT 1 FROM public.pos_transactions t 
        WHERE t.id = transaction_id 
        AND public.is_org_member(auth.uid(), t.organization_id)
    ));

CREATE POLICY "Users can manage transaction payments via transaction"
    ON public.pos_transaction_payments FOR ALL
    USING (EXISTS (
        SELECT 1 FROM public.pos_transactions t 
        WHERE t.id = transaction_id 
        AND public.is_org_member(auth.uid(), t.organization_id)
    ));

-- RLS Policies for pos_cash_movements
CREATE POLICY "Users can view cash movements in their organization"
    ON public.pos_cash_movements FOR SELECT
    USING (public.is_org_member(auth.uid(), organization_id));

CREATE POLICY "Users can manage cash movements in their organization"
    ON public.pos_cash_movements FOR ALL
    USING (public.is_org_member(auth.uid(), organization_id));

-- RLS Policies for pos_held_transactions
CREATE POLICY "Users can view held transactions in their organization"
    ON public.pos_held_transactions FOR SELECT
    USING (public.is_org_member(auth.uid(), organization_id));

CREATE POLICY "Users can manage held transactions in their organization"
    ON public.pos_held_transactions FOR ALL
    USING (public.is_org_member(auth.uid(), organization_id));

-- RLS Policies for pos_discounts
CREATE POLICY "Users can view discounts in their organization"
    ON public.pos_discounts FOR SELECT
    USING (public.is_org_member(auth.uid(), organization_id));

CREATE POLICY "Users can manage discounts in their organization"
    ON public.pos_discounts FOR ALL
    USING (public.is_org_member(auth.uid(), organization_id));

-- RLS Policies for pos_gl_mappings
CREATE POLICY "Users can view GL mappings in their organization"
    ON public.pos_gl_mappings FOR SELECT
    USING (public.is_org_member(auth.uid(), organization_id));

CREATE POLICY "Users can manage GL mappings in their organization"
    ON public.pos_gl_mappings FOR ALL
    USING (public.is_org_member(auth.uid(), organization_id));

-- Triggers for updated_at
CREATE TRIGGER update_pos_registers_updated_at
    BEFORE UPDATE ON public.pos_registers
    FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE TRIGGER update_pos_shifts_updated_at
    BEFORE UPDATE ON public.pos_shifts
    FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE TRIGGER update_pos_transactions_updated_at
    BEFORE UPDATE ON public.pos_transactions
    FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE TRIGGER update_pos_held_transactions_updated_at
    BEFORE UPDATE ON public.pos_held_transactions
    FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE TRIGGER update_pos_discounts_updated_at
    BEFORE UPDATE ON public.pos_discounts
    FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE TRIGGER update_pos_gl_mappings_updated_at
    BEFORE UPDATE ON public.pos_gl_mappings
    FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- Function to get next transaction number
CREATE OR REPLACE FUNCTION public.get_next_pos_transaction_number(_org_id uuid, _register_code text)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
    next_num INTEGER;
    date_prefix TEXT;
BEGIN
    date_prefix := to_char(CURRENT_DATE, 'YYMMDD');
    
    SELECT COALESCE(MAX(
        CAST(NULLIF(regexp_replace(transaction_number, '[^0-9]', '', 'g'), '') AS INTEGER)
    ), 0) + 1
    INTO next_num
    FROM public.pos_transactions
    WHERE organization_id = _org_id
    AND transaction_number LIKE _register_code || '-' || date_prefix || '-%';
    
    RETURN _register_code || '-' || date_prefix || '-' || LPAD(next_num::TEXT, 4, '0');
END;
$$;

-- Function to get next shift number
CREATE OR REPLACE FUNCTION public.get_next_shift_number(_org_id uuid, _register_id uuid)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
    next_num INTEGER;
    date_prefix TEXT;
    register_code TEXT;
BEGIN
    date_prefix := to_char(CURRENT_DATE, 'YYMMDD');
    
    SELECT r.register_code INTO register_code
    FROM public.pos_registers r WHERE r.id = _register_id;
    
    SELECT COUNT(*) + 1 INTO next_num
    FROM public.pos_shifts
    WHERE register_id = _register_id
    AND DATE(opened_at) = CURRENT_DATE;
    
    RETURN 'SH-' || register_code || '-' || date_prefix || '-' || LPAD(next_num::TEXT, 2, '0');
END;
$$;