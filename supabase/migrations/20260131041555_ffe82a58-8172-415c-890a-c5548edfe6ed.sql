-- =============================================
-- Restaurant Mode Enhancements
-- =============================================

-- =============================================
-- 1. ORDER MODIFIERS (Extra cheese, No onions, etc.)
-- =============================================

-- Modifier groups (e.g., "Toppings", "Cooking Preference", "Sides")
CREATE TABLE public.pos_modifier_groups (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    description TEXT,
    selection_type TEXT NOT NULL DEFAULT 'multiple' CHECK (selection_type IN ('single', 'multiple')),
    min_selections INTEGER DEFAULT 0,
    max_selections INTEGER,
    is_required BOOLEAN DEFAULT false,
    is_active BOOLEAN DEFAULT true,
    sort_order INTEGER DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Individual modifiers (e.g., "Extra Cheese +$2", "No Onions")
CREATE TABLE public.pos_modifiers (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
    modifier_group_id UUID NOT NULL REFERENCES public.pos_modifier_groups(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    price_adjustment DECIMAL(10,2) DEFAULT 0,
    is_default BOOLEAN DEFAULT false,
    is_active BOOLEAN DEFAULT true,
    sort_order INTEGER DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Link products to modifier groups
CREATE TABLE public.pos_product_modifier_groups (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    product_id UUID NOT NULL REFERENCES public.products(id) ON DELETE CASCADE,
    modifier_group_id UUID NOT NULL REFERENCES public.pos_modifier_groups(id) ON DELETE CASCADE,
    sort_order INTEGER DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE(product_id, modifier_group_id)
);

-- Store selected modifiers on transaction items
CREATE TABLE public.pos_transaction_item_modifiers (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    transaction_item_id UUID NOT NULL REFERENCES public.pos_transaction_items(id) ON DELETE CASCADE,
    modifier_id UUID NOT NULL REFERENCES public.pos_modifiers(id) ON DELETE RESTRICT,
    modifier_name TEXT NOT NULL,
    price_adjustment DECIMAL(10,2) DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- =============================================
-- 2. BILL SPLITTING
-- =============================================

-- Track split bills from a single table session
CREATE TABLE public.pos_split_bills (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
    table_session_id UUID NOT NULL REFERENCES public.pos_table_sessions(id) ON DELETE CASCADE,
    split_type TEXT NOT NULL CHECK (split_type IN ('by_item', 'by_seat', 'equal', 'custom')),
    split_count INTEGER NOT NULL DEFAULT 2,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_by UUID REFERENCES auth.users(id)
);

-- Individual split portions
CREATE TABLE public.pos_split_bill_portions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    split_bill_id UUID NOT NULL REFERENCES public.pos_split_bills(id) ON DELETE CASCADE,
    portion_number INTEGER NOT NULL,
    seat_label TEXT,
    amount DECIMAL(10,2) NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'paid', 'cancelled')),
    transaction_id UUID REFERENCES public.pos_transactions(id),
    paid_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Link items to split portions
CREATE TABLE public.pos_split_bill_items (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    portion_id UUID NOT NULL REFERENCES public.pos_split_bill_portions(id) ON DELETE CASCADE,
    transaction_item_id UUID NOT NULL REFERENCES public.pos_transaction_items(id) ON DELETE CASCADE,
    quantity DECIMAL(10,3) NOT NULL DEFAULT 1,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- =============================================
-- 3. TABLE MERGE/TRANSFER
-- =============================================

-- Track table merges and item transfers
CREATE TABLE public.pos_table_transfers (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
    transfer_type TEXT NOT NULL CHECK (transfer_type IN ('merge', 'transfer_items', 'move_session')),
    source_session_id UUID NOT NULL REFERENCES public.pos_table_sessions(id) ON DELETE CASCADE,
    target_session_id UUID NOT NULL REFERENCES public.pos_table_sessions(id) ON DELETE CASCADE,
    notes TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_by UUID REFERENCES auth.users(id)
);

-- Track which items were transferred
CREATE TABLE public.pos_transfer_items (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    transfer_id UUID NOT NULL REFERENCES public.pos_table_transfers(id) ON DELETE CASCADE,
    transaction_item_id UUID NOT NULL REFERENCES public.pos_transaction_items(id) ON DELETE CASCADE,
    quantity DECIMAL(10,3) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- =============================================
-- 4. WAITLIST MANAGEMENT
-- =============================================

CREATE TABLE public.pos_waitlist (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
    branch_id UUID REFERENCES public.branches(id),
    customer_name TEXT NOT NULL,
    phone TEXT,
    party_size INTEGER NOT NULL DEFAULT 2,
    notes TEXT,
    quoted_wait_minutes INTEGER,
    seating_preference TEXT,
    status TEXT NOT NULL DEFAULT 'waiting' CHECK (status IN ('waiting', 'notified', 'seated', 'no_show', 'cancelled')),
    check_in_time TIMESTAMPTZ NOT NULL DEFAULT now(),
    notified_at TIMESTAMPTZ,
    seated_at TIMESTAMPTZ,
    table_id UUID REFERENCES public.pos_tables(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_by UUID REFERENCES auth.users(id)
);

-- =============================================
-- 5. HAPPY HOUR / TIME-BASED PRICING
-- =============================================

CREATE TABLE public.pos_happy_hours (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
    branch_id UUID REFERENCES public.branches(id),
    name TEXT NOT NULL,
    description TEXT,
    discount_type TEXT NOT NULL CHECK (discount_type IN ('percentage', 'fixed_amount', 'fixed_price')),
    discount_value DECIMAL(10,2) NOT NULL,
    start_time TIME NOT NULL,
    end_time TIME NOT NULL,
    days_of_week INTEGER[] NOT NULL DEFAULT ARRAY[0,1,2,3,4,5,6],
    is_active BOOLEAN DEFAULT true,
    priority INTEGER DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Link happy hours to specific products (removed category reference)
CREATE TABLE public.pos_happy_hour_items (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    happy_hour_id UUID NOT NULL REFERENCES public.pos_happy_hours(id) ON DELETE CASCADE,
    product_id UUID NOT NULL REFERENCES public.products(id) ON DELETE CASCADE,
    override_discount_type TEXT CHECK (override_discount_type IN ('percentage', 'fixed_amount', 'fixed_price')),
    override_discount_value DECIMAL(10,2),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- =============================================
-- INDEXES
-- =============================================

CREATE INDEX idx_pos_modifiers_group ON public.pos_modifiers(modifier_group_id);
CREATE INDEX idx_pos_product_modifier_groups_product ON public.pos_product_modifier_groups(product_id);
CREATE INDEX idx_pos_transaction_item_modifiers_item ON public.pos_transaction_item_modifiers(transaction_item_id);
CREATE INDEX idx_pos_split_bills_session ON public.pos_split_bills(table_session_id);
CREATE INDEX idx_pos_waitlist_org_status ON public.pos_waitlist(organization_id, status);
CREATE INDEX idx_pos_happy_hours_org ON public.pos_happy_hours(organization_id, is_active);

-- =============================================
-- RLS POLICIES (using is_org_member function)
-- =============================================

ALTER TABLE public.pos_modifier_groups ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pos_modifiers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pos_product_modifier_groups ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pos_transaction_item_modifiers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pos_split_bills ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pos_split_bill_portions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pos_split_bill_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pos_table_transfers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pos_transfer_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pos_waitlist ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pos_happy_hours ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pos_happy_hour_items ENABLE ROW LEVEL SECURITY;

-- Modifier Groups
CREATE POLICY "Users can view modifier groups in their organization"
ON public.pos_modifier_groups FOR SELECT
USING (is_org_member(auth.uid(), organization_id));

CREATE POLICY "Users can manage modifier groups in their organization"
ON public.pos_modifier_groups FOR ALL
USING (is_org_member(auth.uid(), organization_id));

-- Modifiers
CREATE POLICY "Users can view modifiers in their organization"
ON public.pos_modifiers FOR SELECT
USING (is_org_member(auth.uid(), organization_id));

CREATE POLICY "Users can manage modifiers in their organization"
ON public.pos_modifiers FOR ALL
USING (is_org_member(auth.uid(), organization_id));

-- Product Modifier Groups (join table - access via product's org)
CREATE POLICY "Users can view product modifier groups"
ON public.pos_product_modifier_groups FOR SELECT
USING (EXISTS (
    SELECT 1 FROM public.products p
    WHERE p.id = product_id AND is_org_member(auth.uid(), p.organization_id)
));

CREATE POLICY "Users can manage product modifier groups"
ON public.pos_product_modifier_groups FOR ALL
USING (EXISTS (
    SELECT 1 FROM public.products p
    WHERE p.id = product_id AND is_org_member(auth.uid(), p.organization_id)
));

-- Transaction Item Modifiers (access via transaction item's org)
CREATE POLICY "Users can view transaction item modifiers"
ON public.pos_transaction_item_modifiers FOR SELECT
USING (EXISTS (
    SELECT 1 FROM public.pos_transaction_items ti
    JOIN public.pos_transactions t ON t.id = ti.transaction_id
    WHERE ti.id = transaction_item_id AND is_org_member(auth.uid(), t.organization_id)
));

CREATE POLICY "Users can manage transaction item modifiers"
ON public.pos_transaction_item_modifiers FOR ALL
USING (EXISTS (
    SELECT 1 FROM public.pos_transaction_items ti
    JOIN public.pos_transactions t ON t.id = ti.transaction_id
    WHERE ti.id = transaction_item_id AND is_org_member(auth.uid(), t.organization_id)
));

-- Split Bills
CREATE POLICY "Users can view split bills in their organization"
ON public.pos_split_bills FOR SELECT
USING (is_org_member(auth.uid(), organization_id));

CREATE POLICY "Users can manage split bills in their organization"
ON public.pos_split_bills FOR ALL
USING (is_org_member(auth.uid(), organization_id));

-- Split Bill Portions (access via split bill's org)
CREATE POLICY "Users can view split bill portions"
ON public.pos_split_bill_portions FOR SELECT
USING (EXISTS (
    SELECT 1 FROM public.pos_split_bills sb
    WHERE sb.id = split_bill_id AND is_org_member(auth.uid(), sb.organization_id)
));

CREATE POLICY "Users can manage split bill portions"
ON public.pos_split_bill_portions FOR ALL
USING (EXISTS (
    SELECT 1 FROM public.pos_split_bills sb
    WHERE sb.id = split_bill_id AND is_org_member(auth.uid(), sb.organization_id)
));

-- Split Bill Items (access via portion's split bill's org)
CREATE POLICY "Users can view split bill items"
ON public.pos_split_bill_items FOR SELECT
USING (EXISTS (
    SELECT 1 FROM public.pos_split_bill_portions p
    JOIN public.pos_split_bills sb ON sb.id = p.split_bill_id
    WHERE p.id = portion_id AND is_org_member(auth.uid(), sb.organization_id)
));

CREATE POLICY "Users can manage split bill items"
ON public.pos_split_bill_items FOR ALL
USING (EXISTS (
    SELECT 1 FROM public.pos_split_bill_portions p
    JOIN public.pos_split_bills sb ON sb.id = p.split_bill_id
    WHERE p.id = portion_id AND is_org_member(auth.uid(), sb.organization_id)
));

-- Table Transfers
CREATE POLICY "Users can view table transfers in their organization"
ON public.pos_table_transfers FOR SELECT
USING (is_org_member(auth.uid(), organization_id));

CREATE POLICY "Users can manage table transfers in their organization"
ON public.pos_table_transfers FOR ALL
USING (is_org_member(auth.uid(), organization_id));

-- Transfer Items (access via transfer's org)
CREATE POLICY "Users can view transfer items"
ON public.pos_transfer_items FOR SELECT
USING (EXISTS (
    SELECT 1 FROM public.pos_table_transfers tt
    WHERE tt.id = transfer_id AND is_org_member(auth.uid(), tt.organization_id)
));

CREATE POLICY "Users can manage transfer items"
ON public.pos_transfer_items FOR ALL
USING (EXISTS (
    SELECT 1 FROM public.pos_table_transfers tt
    WHERE tt.id = transfer_id AND is_org_member(auth.uid(), tt.organization_id)
));

-- Waitlist
CREATE POLICY "Users can view waitlist in their organization"
ON public.pos_waitlist FOR SELECT
USING (is_org_member(auth.uid(), organization_id));

CREATE POLICY "Users can manage waitlist in their organization"
ON public.pos_waitlist FOR ALL
USING (is_org_member(auth.uid(), organization_id));

-- Happy Hours
CREATE POLICY "Users can view happy hours in their organization"
ON public.pos_happy_hours FOR SELECT
USING (is_org_member(auth.uid(), organization_id));

CREATE POLICY "Users can manage happy hours in their organization"
ON public.pos_happy_hours FOR ALL
USING (is_org_member(auth.uid(), organization_id));

-- Happy Hour Items (access via happy hour's org)
CREATE POLICY "Users can view happy hour items"
ON public.pos_happy_hour_items FOR SELECT
USING (EXISTS (
    SELECT 1 FROM public.pos_happy_hours hh
    WHERE hh.id = happy_hour_id AND is_org_member(auth.uid(), hh.organization_id)
));

CREATE POLICY "Users can manage happy hour items"
ON public.pos_happy_hour_items FOR ALL
USING (EXISTS (
    SELECT 1 FROM public.pos_happy_hours hh
    WHERE hh.id = happy_hour_id AND is_org_member(auth.uid(), hh.organization_id)
));