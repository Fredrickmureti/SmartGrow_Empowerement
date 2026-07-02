-- Add 'cashier' to app_role enum
ALTER TYPE public.app_role ADD VALUE IF NOT EXISTS 'cashier';

-- =====================================================
-- POS CASHIERS TABLE - Register-assigned cashiers with PIN auth
-- =====================================================
CREATE TABLE public.pos_cashiers (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    employee_number VARCHAR(50),
    display_name VARCHAR(100) NOT NULL,
    pin_hash TEXT, -- 4-6 digit PIN, hashed
    is_active BOOLEAN DEFAULT true,
    can_void_transactions BOOLEAN DEFAULT false,
    can_apply_discounts BOOLEAN DEFAULT false,
    can_process_returns BOOLEAN DEFAULT false,
    can_open_cash_drawer BOOLEAN DEFAULT false,
    max_discount_percent NUMERIC(5,2) DEFAULT 0,
    max_void_amount NUMERIC(12,2) DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now(),
    created_by UUID REFERENCES auth.users(id),
    UNIQUE(organization_id, user_id),
    UNIQUE(organization_id, employee_number)
);

-- =====================================================
-- CASHIER REGISTER ASSIGNMENTS - Link cashiers to specific registers
-- =====================================================
CREATE TABLE public.pos_cashier_registers (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    cashier_id UUID NOT NULL REFERENCES public.pos_cashiers(id) ON DELETE CASCADE,
    register_id UUID NOT NULL REFERENCES public.pos_registers(id) ON DELETE CASCADE,
    is_primary BOOLEAN DEFAULT false,
    assigned_at TIMESTAMPTZ DEFAULT now(),
    assigned_by UUID REFERENCES auth.users(id),
    UNIQUE(cashier_id, register_id)
);

-- =====================================================
-- POS SESSIONS TABLE - Terminal session tracking for security
-- =====================================================
CREATE TABLE public.pos_sessions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
    cashier_id UUID NOT NULL REFERENCES public.pos_cashiers(id) ON DELETE CASCADE,
    register_id UUID NOT NULL REFERENCES public.pos_registers(id) ON DELETE CASCADE,
    shift_id UUID REFERENCES public.pos_shifts(id) ON DELETE SET NULL,
    session_token UUID NOT NULL DEFAULT gen_random_uuid(),
    started_at TIMESTAMPTZ DEFAULT now(),
    last_activity_at TIMESTAMPTZ DEFAULT now(),
    ended_at TIMESTAMPTZ,
    status VARCHAR(20) DEFAULT 'active' CHECK (status IN ('active', 'locked', 'ended', 'force_ended')),
    lock_reason VARCHAR(100),
    locked_at TIMESTAMPTZ,
    ended_by UUID REFERENCES auth.users(id),
    device_info JSONB,
    UNIQUE(session_token)
);

-- Only one active session per cashier per register
CREATE UNIQUE INDEX idx_pos_sessions_one_active 
ON pos_sessions (cashier_id, register_id) 
WHERE status = 'active';

-- =====================================================
-- MANAGER PINS TABLE - For manager override authentication
-- =====================================================
CREATE TABLE public.pos_manager_pins (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    pin_hash TEXT NOT NULL, -- Manager's approval PIN
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now(),
    UNIQUE(organization_id, user_id)
);

-- =====================================================
-- MANAGER OVERRIDE LOG - Audit trail for manager approvals
-- =====================================================
CREATE TABLE public.pos_manager_overrides (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
    session_id UUID REFERENCES public.pos_sessions(id) ON DELETE SET NULL,
    register_id UUID REFERENCES public.pos_registers(id) ON DELETE SET NULL,
    cashier_id UUID REFERENCES public.pos_cashiers(id) ON DELETE SET NULL,
    manager_id UUID NOT NULL REFERENCES auth.users(id),
    override_type VARCHAR(50) NOT NULL, -- 'void', 'discount', 'return', 'price_change', 'drawer_open'
    override_reason TEXT,
    transaction_id UUID REFERENCES public.pos_transactions(id) ON DELETE SET NULL,
    amount NUMERIC(12,2),
    original_value NUMERIC(12,2),
    new_value NUMERIC(12,2),
    approved_at TIMESTAMPTZ DEFAULT now(),
    metadata JSONB
);

-- =====================================================
-- UPDATE POS_REGISTERS - Add security settings
-- =====================================================
ALTER TABLE public.pos_registers 
ADD COLUMN IF NOT EXISTS require_cashier_login BOOLEAN DEFAULT true,
ADD COLUMN IF NOT EXISTS auto_lock_minutes INTEGER DEFAULT 5,
ADD COLUMN IF NOT EXISTS require_manager_for_void BOOLEAN DEFAULT true,
ADD COLUMN IF NOT EXISTS require_manager_for_discount BOOLEAN DEFAULT true,
ADD COLUMN IF NOT EXISTS require_manager_for_return BOOLEAN DEFAULT true,
ADD COLUMN IF NOT EXISTS max_cash_limit NUMERIC(12,2),
ADD COLUMN IF NOT EXISTS void_limit_per_shift NUMERIC(12,2);

-- =====================================================
-- UPDATE POS_SHIFTS - Link to cashier session
-- =====================================================
ALTER TABLE public.pos_shifts
ADD COLUMN IF NOT EXISTS cashier_id UUID REFERENCES public.pos_cashiers(id) ON DELETE SET NULL,
ADD COLUMN IF NOT EXISTS session_id UUID REFERENCES public.pos_sessions(id) ON DELETE SET NULL;

-- =====================================================
-- POS SECURITY SETTINGS - Organization-level POS security config
-- =====================================================
CREATE TABLE public.pos_security_settings (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE UNIQUE,
    require_cashier_pin BOOLEAN DEFAULT true,
    pin_length INTEGER DEFAULT 4 CHECK (pin_length >= 4 AND pin_length <= 8),
    session_timeout_minutes INTEGER DEFAULT 30,
    lock_after_inactivity_minutes INTEGER DEFAULT 5,
    require_manager_pin_for_void BOOLEAN DEFAULT true,
    require_manager_pin_for_discount BOOLEAN DEFAULT true,
    require_manager_pin_for_return BOOLEAN DEFAULT true,
    require_manager_pin_for_price_override BOOLEAN DEFAULT true,
    require_manager_pin_for_drawer_open BOOLEAN DEFAULT false,
    void_limit_requires_approval NUMERIC(12,2) DEFAULT 0,
    discount_limit_requires_approval NUMERIC(5,2) DEFAULT 10, -- percent
    allow_offline_transactions BOOLEAN DEFAULT true,
    max_offline_transaction_amount NUMERIC(12,2) DEFAULT 10000,
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now()
);

-- =====================================================
-- ENABLE RLS ON ALL NEW TABLES
-- =====================================================
ALTER TABLE public.pos_cashiers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pos_cashier_registers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pos_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pos_manager_pins ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pos_manager_overrides ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pos_security_settings ENABLE ROW LEVEL SECURITY;

-- =====================================================
-- RLS POLICIES FOR POS_CASHIERS
-- =====================================================
CREATE POLICY "Users can view cashiers in their organization"
ON public.pos_cashiers FOR SELECT
TO authenticated
USING (
    organization_id IN (
        SELECT organization_id FROM public.user_roles 
        WHERE user_id = auth.uid()
    )
);

CREATE POLICY "Managers can create cashiers"
ON public.pos_cashiers FOR INSERT
TO authenticated
WITH CHECK (
    organization_id IN (
        SELECT organization_id FROM public.user_roles
        WHERE user_id = auth.uid()
        AND role IN ('owner', 'admin', 'super_admin')
    )
);

CREATE POLICY "Managers can update cashiers"
ON public.pos_cashiers FOR UPDATE
TO authenticated
USING (
    organization_id IN (
        SELECT organization_id FROM public.user_roles
        WHERE user_id = auth.uid()
        AND role IN ('owner', 'admin', 'super_admin')
    )
);

CREATE POLICY "Managers can delete cashiers"
ON public.pos_cashiers FOR DELETE
TO authenticated
USING (
    organization_id IN (
        SELECT organization_id FROM public.user_roles
        WHERE user_id = auth.uid()
        AND role IN ('owner', 'admin', 'super_admin')
    )
);

-- =====================================================
-- RLS POLICIES FOR POS_CASHIER_REGISTERS
-- =====================================================
CREATE POLICY "Users can view cashier register assignments"
ON public.pos_cashier_registers FOR SELECT
TO authenticated
USING (
    cashier_id IN (
        SELECT id FROM public.pos_cashiers 
        WHERE organization_id IN (
            SELECT organization_id FROM public.user_roles 
            WHERE user_id = auth.uid()
        )
    )
);

CREATE POLICY "Managers can manage cashier register assignments"
ON public.pos_cashier_registers FOR ALL
TO authenticated
USING (
    cashier_id IN (
        SELECT pc.id FROM public.pos_cashiers pc
        WHERE pc.organization_id IN (
            SELECT organization_id FROM public.user_roles
            WHERE user_id = auth.uid()
            AND role IN ('owner', 'admin', 'super_admin')
        )
    )
);

-- =====================================================
-- RLS POLICIES FOR POS_SESSIONS
-- =====================================================
CREATE POLICY "Users can view sessions in their organization"
ON public.pos_sessions FOR SELECT
TO authenticated
USING (
    organization_id IN (
        SELECT organization_id FROM public.user_roles 
        WHERE user_id = auth.uid()
    )
);

CREATE POLICY "Cashiers can create their own sessions"
ON public.pos_sessions FOR INSERT
TO authenticated
WITH CHECK (
    organization_id IN (
        SELECT organization_id FROM public.user_roles 
        WHERE user_id = auth.uid()
    )
);

CREATE POLICY "Users can update sessions in their organization"
ON public.pos_sessions FOR UPDATE
TO authenticated
USING (
    organization_id IN (
        SELECT organization_id FROM public.user_roles 
        WHERE user_id = auth.uid()
    )
);

-- =====================================================
-- RLS POLICIES FOR POS_MANAGER_PINS
-- =====================================================
CREATE POLICY "Users can view their own manager pin status"
ON public.pos_manager_pins FOR SELECT
TO authenticated
USING (user_id = auth.uid());

CREATE POLICY "Users can manage their own manager pin"
ON public.pos_manager_pins FOR ALL
TO authenticated
USING (user_id = auth.uid());

-- =====================================================
-- RLS POLICIES FOR POS_MANAGER_OVERRIDES
-- =====================================================
CREATE POLICY "Users can view overrides in their organization"
ON public.pos_manager_overrides FOR SELECT
TO authenticated
USING (
    organization_id IN (
        SELECT organization_id FROM public.user_roles 
        WHERE user_id = auth.uid()
    )
);

CREATE POLICY "Managers can create overrides"
ON public.pos_manager_overrides FOR INSERT
TO authenticated
WITH CHECK (
    organization_id IN (
        SELECT organization_id FROM public.user_roles 
        WHERE user_id = auth.uid()
    )
    AND manager_id = auth.uid()
);

-- =====================================================
-- RLS POLICIES FOR POS_SECURITY_SETTINGS
-- =====================================================
CREATE POLICY "Users can view security settings in their organization"
ON public.pos_security_settings FOR SELECT
TO authenticated
USING (
    organization_id IN (
        SELECT organization_id FROM public.user_roles 
        WHERE user_id = auth.uid()
    )
);

CREATE POLICY "Managers can manage security settings"
ON public.pos_security_settings FOR ALL
TO authenticated
USING (
    organization_id IN (
        SELECT organization_id FROM public.user_roles
        WHERE user_id = auth.uid()
        AND role IN ('owner', 'admin', 'super_admin')
    )
);

-- =====================================================
-- FUNCTION: Verify Cashier PIN (SECURITY DEFINER)
-- =====================================================
CREATE OR REPLACE FUNCTION public.verify_cashier_pin(
    p_cashier_id UUID,
    p_pin TEXT
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_pin_hash TEXT;
    v_is_active BOOLEAN;
BEGIN
    SELECT pin_hash, is_active 
    INTO v_pin_hash, v_is_active
    FROM public.pos_cashiers 
    WHERE id = p_cashier_id;
    
    IF NOT FOUND OR NOT v_is_active THEN
        RETURN FALSE;
    END IF;
    
    -- Simple comparison using pgcrypto
    RETURN v_pin_hash = crypt(p_pin, v_pin_hash);
END;
$$;

-- =====================================================
-- FUNCTION: Verify Manager PIN (SECURITY DEFINER)
-- =====================================================
CREATE OR REPLACE FUNCTION public.verify_manager_pin(
    p_organization_id UUID,
    p_manager_id UUID,
    p_pin TEXT
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_pin_hash TEXT;
    v_is_active BOOLEAN;
    v_has_role BOOLEAN;
BEGIN
    -- Check if user has manager role
    SELECT EXISTS (
        SELECT 1 FROM public.user_roles 
        WHERE user_id = p_manager_id 
        AND role IN ('owner', 'admin', 'super_admin')
    ) INTO v_has_role;
    
    IF NOT v_has_role THEN
        RETURN FALSE;
    END IF;
    
    SELECT pin_hash, is_active 
    INTO v_pin_hash, v_is_active
    FROM public.pos_manager_pins 
    WHERE organization_id = p_organization_id 
    AND user_id = p_manager_id;
    
    IF NOT FOUND OR NOT v_is_active THEN
        RETURN FALSE;
    END IF;
    
    RETURN v_pin_hash = crypt(p_pin, v_pin_hash);
END;
$$;

-- =====================================================
-- FUNCTION: Set Cashier PIN (with hashing)
-- =====================================================
CREATE OR REPLACE FUNCTION public.set_cashier_pin(
    p_cashier_id UUID,
    p_pin TEXT
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    UPDATE public.pos_cashiers 
    SET 
        pin_hash = crypt(p_pin, gen_salt('bf')),
        updated_at = now()
    WHERE id = p_cashier_id;
    
    RETURN FOUND;
END;
$$;

-- =====================================================
-- FUNCTION: Set Manager PIN (with hashing)
-- =====================================================
CREATE OR REPLACE FUNCTION public.set_manager_pin(
    p_organization_id UUID,
    p_user_id UUID,
    p_pin TEXT
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    INSERT INTO public.pos_manager_pins (organization_id, user_id, pin_hash)
    VALUES (p_organization_id, p_user_id, crypt(p_pin, gen_salt('bf')))
    ON CONFLICT (organization_id, user_id) 
    DO UPDATE SET 
        pin_hash = crypt(p_pin, gen_salt('bf')),
        updated_at = now();
    
    RETURN TRUE;
END;
$$;

-- =====================================================
-- FUNCTION: Lock Cashier Session (force logout)
-- =====================================================
CREATE OR REPLACE FUNCTION public.lock_cashier_session(
    p_cashier_id UUID,
    p_reason TEXT DEFAULT 'Account disabled'
)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_count INTEGER;
BEGIN
    UPDATE public.pos_sessions
    SET 
        status = 'locked',
        lock_reason = p_reason,
        locked_at = now()
    WHERE cashier_id = p_cashier_id
    AND status = 'active';
    
    GET DIAGNOSTICS v_count = ROW_COUNT;
    RETURN v_count;
END;
$$;

-- =====================================================
-- FUNCTION: Force End All Sessions for Cashier
-- =====================================================
CREATE OR REPLACE FUNCTION public.force_end_cashier_sessions(
    p_cashier_id UUID,
    p_ended_by UUID
)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_count INTEGER;
BEGIN
    UPDATE public.pos_sessions
    SET 
        status = 'force_ended',
        ended_at = now(),
        ended_by = p_ended_by,
        lock_reason = 'Cashier account disabled or removed'
    WHERE cashier_id = p_cashier_id
    AND status IN ('active', 'locked');
    
    GET DIAGNOSTICS v_count = ROW_COUNT;
    RETURN v_count;
END;
$$;

-- =====================================================
-- TRIGGERS FOR UPDATED_AT
-- =====================================================
CREATE TRIGGER update_pos_cashiers_updated_at
BEFORE UPDATE ON public.pos_cashiers
FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE TRIGGER update_pos_security_settings_updated_at
BEFORE UPDATE ON public.pos_security_settings
FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE TRIGGER update_pos_manager_pins_updated_at
BEFORE UPDATE ON public.pos_manager_pins
FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- =====================================================
-- INDEXES FOR PERFORMANCE
-- =====================================================
CREATE INDEX idx_pos_cashiers_org ON pos_cashiers(organization_id);
CREATE INDEX idx_pos_cashiers_user ON pos_cashiers(user_id);
CREATE INDEX idx_pos_sessions_org ON pos_sessions(organization_id);
CREATE INDEX idx_pos_sessions_cashier ON pos_sessions(cashier_id);
CREATE INDEX idx_pos_sessions_status ON pos_sessions(status);
CREATE INDEX idx_pos_manager_overrides_org ON pos_manager_overrides(organization_id);
CREATE INDEX idx_pos_manager_overrides_session ON pos_manager_overrides(session_id);
CREATE INDEX idx_pos_cashier_registers_register ON pos_cashier_registers(register_id);