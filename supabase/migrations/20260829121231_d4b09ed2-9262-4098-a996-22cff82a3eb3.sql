-- =====================================================================
-- STEP 1 — PLATFORM CORE BASELINE
-- Reconstructed from the reference platform's migration history.
-- =====================================================================

-- Shared updated_at trigger function
CREATE OR REPLACE FUNCTION public.update_updated_at_column()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

-- Roles enum
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'app_role') THEN
    CREATE TYPE public.app_role AS ENUM ('super_admin', 'owner', 'admin', 'accountant', 'staff', 'viewer');
  END IF;
END $$;

-- ---------------------------------------------------------------- orgs
CREATE TABLE IF NOT EXISTS public.organizations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  slug TEXT UNIQUE NOT NULL,
  owner_user_id UUID,
  governance_mode TEXT NOT NULL DEFAULT 'solo',
  setup_wizard_completed BOOLEAN DEFAULT false,
  setup_wizard_step INTEGER DEFAULT 0,
  onboarding_idempotency_key TEXT,
  subscription_status TEXT DEFAULT 'trial'
    CHECK (subscription_status IN ('trial','active','past_due','cancelled','suspended')),
  subscription_plan_id UUID,
  subscription_started_at TIMESTAMPTZ,
  subscription_ends_at TIMESTAMPTZ,
  trial_ends_at TIMESTAMPTZ DEFAULT (now() + interval '14 days'),
  external_subscription_id TEXT,
  external_customer_id TEXT,
  is_suspended BOOLEAN DEFAULT false,
  suspended_at TIMESTAMPTZ,
  suspended_reason TEXT,
  created_by_platform_admin BOOLEAN NOT NULL DEFAULT false,
  fiscalyear_lock_date DATE,
  period_lock_date DATE,
  tax_lock_date DATE,
  deletion_status TEXT NOT NULL DEFAULT 'active',
  deletion_scheduled_at TIMESTAMPTZ,
  scheduled_deletion_at TIMESTAMPTZ,
  deletion_grace_days INTEGER,
  deletion_requested_by UUID,
  deletion_reason TEXT,
  deletion_cancelled_at TIMESTAMPTZ,
  edge_allowed_origins TEXT[] NOT NULL DEFAULT ARRAY[]::text[],
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.organizations TO authenticated;
GRANT ALL ON public.organizations TO service_role;
ALTER TABLE public.organizations ENABLE ROW LEVEL SECURITY;

-- ------------------------------------------------------------ profiles
CREATE TABLE IF NOT EXISTS public.profiles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL UNIQUE REFERENCES auth.users(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  full_name TEXT,
  avatar_url TEXT,
  phone TEXT,
  preferred_currency TEXT,
  last_org_id UUID REFERENCES public.organizations(id) ON DELETE SET NULL,
  last_login_at TIMESTAMPTZ,
  last_activity_at TIMESTAMPTZ,
  login_count INTEGER DEFAULT 0,
  engagement_score INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE ON public.profiles TO authenticated;
GRANT ALL ON public.profiles TO service_role;
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;

-- ---------------------------------------------------------- user_roles
CREATE TABLE IF NOT EXISTS public.user_roles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  role public.app_role NOT NULL DEFAULT 'viewer',
  user_type TEXT NOT NULL DEFAULT 'internal',
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, organization_id)
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.user_roles TO authenticated;
GRANT ALL ON public.user_roles TO service_role;
ALTER TABLE public.user_roles ENABLE ROW LEVEL SECURITY;

-- ------------------------------------------- security definer helpers
CREATE OR REPLACE FUNCTION public.has_role(_user_id UUID, _organization_id UUID, _role public.app_role)
RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.user_roles
    WHERE user_id = _user_id AND organization_id = _organization_id
      AND role = _role AND is_active = true
  )
$$;

CREATE OR REPLACE FUNCTION public.is_org_member(_user_id UUID, _organization_id UUID)
RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.user_roles
    WHERE user_id = _user_id AND organization_id = _organization_id AND is_active = true
  )
$$;

CREATE OR REPLACE FUNCTION public.get_user_organizations(_user_id UUID)
RETURNS SETOF UUID LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT organization_id FROM public.user_roles
  WHERE user_id = _user_id AND is_active = true
$$;

CREATE OR REPLACE FUNCTION public.is_org_manager(_user_id UUID, _organization_id UUID)
RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.user_roles
    WHERE user_id = _user_id AND organization_id = _organization_id
      AND is_active = true AND role IN ('super_admin','owner','admin')
  )
$$;

-- ---------------------------------------------------------- businesses
CREATE TABLE IF NOT EXISTS public.businesses (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  legal_name TEXT,
  tax_id TEXT,
  registration_number TEXT,
  logo_url TEXT,
  email TEXT,
  phone TEXT,
  website TEXT,
  address TEXT,
  city TEXT,
  state TEXT,
  postal_code TEXT,
  country TEXT NOT NULL DEFAULT 'KE',
  base_currency TEXT NOT NULL DEFAULT 'KES',
  industry TEXT,
  business_type TEXT,
  fiscal_year_start INTEGER,
  timezone TEXT,
  date_format TEXT,
  number_format TEXT,
  week_starts_on SMALLINT NOT NULL DEFAULT 1,
  weekly_hours_target NUMERIC(5,2) NOT NULL DEFAULT 40,
  default_tax_rate_id UUID,
  email_display_name TEXT,
  email_reply_to TEXT,
  invoice_prefix TEXT,
  estimate_prefix TEXT,
  bill_prefix TEXT,
  credit_note_prefix TEXT DEFAULT 'CN-',
  proforma_prefix TEXT,
  sales_return_prefix TEXT,
  receipt_settings JSONB NOT NULL DEFAULT '{}'::jsonb,
  receipt_theme JSONB,
  receipt_engine_v2 BOOLEAN NOT NULL DEFAULT false,
  cost_model TEXT NOT NULL DEFAULT 'wac' CHECK (cost_model IN ('wac','fifo')),
  use_holding_accounts BOOLEAN NOT NULL DEFAULT false,
  finance_readiness TEXT NOT NULL DEFAULT 'pending'
    CHECK (finance_readiness IN ('pending','ready','degraded')),
  finance_readiness_reason TEXT,
  finance_readiness_checked_at TIMESTAMPTZ,
  setup_wizard_completed BOOLEAN DEFAULT false,
  setup_wizard_step INTEGER DEFAULT 0,
  is_active BOOLEAN DEFAULT true,
  archived_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.businesses TO authenticated;
GRANT ALL ON public.businesses TO service_role;
ALTER TABLE public.businesses ENABLE ROW LEVEL SECURITY;

-- ------------------------------------------------------------ branches
CREATE TABLE IF NOT EXISTS public.branches (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  code TEXT,
  email TEXT,
  phone TEXT,
  address TEXT,
  city TEXT,
  state TEXT,
  postal_code TEXT,
  country TEXT,
  logo_url TEXT,
  receipt_header TEXT,
  receipt_footer TEXT,
  invoice_prefix_suffix TEXT,
  default_warehouse_id UUID,
  is_headquarters BOOLEAN DEFAULT false,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.branches TO authenticated;
GRANT ALL ON public.branches TO service_role;
ALTER TABLE public.branches ENABLE ROW LEVEL SECURITY;

-- --------------------------------------------------------- invitations
CREATE TABLE IF NOT EXISTS public.organization_invitations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  role public.app_role NOT NULL DEFAULT 'viewer',
  user_type TEXT NOT NULL DEFAULT 'internal',
  permission_group_ids UUID[] NOT NULL DEFAULT '{}'::uuid[],
  employee_id UUID,
  invited_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  token TEXT UNIQUE NOT NULL DEFAULT gen_random_uuid()::text,
  expires_at TIMESTAMPTZ NOT NULL DEFAULT (now() + interval '7 days'),
  accepted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.organization_invitations TO authenticated;
GRANT ALL ON public.organization_invitations TO service_role;
ALTER TABLE public.organization_invitations ENABLE ROW LEVEL SECURITY;

-- --------------------------------------------------------- audit_logs
CREATE TABLE IF NOT EXISTS public.audit_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  business_id UUID REFERENCES public.businesses(id),
  user_id UUID,
  action TEXT NOT NULL CHECK (action IN ('create','update','delete','view','export','login','logout')),
  entity_type TEXT NOT NULL,
  entity_id UUID,
  entity_name TEXT,
  old_values JSONB,
  new_values JSONB,
  changes_summary TEXT,
  ip_address TEXT,
  user_agent TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT ON public.audit_logs TO authenticated;
GRANT ALL ON public.audit_logs TO service_role;
ALTER TABLE public.audit_logs ENABLE ROW LEVEL SECURITY;

-- ---------------------------------------------------------- user_pins
CREATE TABLE IF NOT EXISTS public.user_pins (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  device_fingerprint TEXT,
  pin_hash TEXT NOT NULL,
  pin_length INTEGER NOT NULL DEFAULT 4 CHECK (pin_length >= 4 AND pin_length <= 6),
  is_active BOOLEAN NOT NULL DEFAULT true,
  failed_attempts INTEGER NOT NULL DEFAULT 0,
  locked_until TIMESTAMPTZ,
  last_used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, device_fingerprint)
);

GRANT ALL ON public.user_pins TO service_role;
ALTER TABLE public.user_pins ENABLE ROW LEVEL SECURITY;

-- --------------------------------------------------- platform_settings
CREATE TABLE IF NOT EXISTS public.platform_settings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  setting_key TEXT NOT NULL UNIQUE,
  setting_value TEXT,
  setting_type TEXT NOT NULL DEFAULT 'string',
  description TEXT,
  is_secret BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

GRANT SELECT ON public.platform_settings TO authenticated;
GRANT ALL ON public.platform_settings TO service_role;
ALTER TABLE public.platform_settings ENABLE ROW LEVEL SECURITY;

-- ============================== POLICIES =============================
CREATE POLICY "Members can view their organizations"
  ON public.organizations FOR SELECT TO authenticated
  USING (id IN (SELECT public.get_user_organizations(auth.uid())));

CREATE POLICY "Managers can update their organization"
  ON public.organizations FOR UPDATE TO authenticated
  USING (public.is_org_manager(auth.uid(), id));

CREATE POLICY "Users can view their own profile"
  ON public.profiles FOR SELECT TO authenticated
  USING (auth.uid() = user_id);

CREATE POLICY "Users can insert their own profile"
  ON public.profiles FOR INSERT TO authenticated
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update their own profile"
  ON public.profiles FOR UPDATE TO authenticated
  USING (auth.uid() = user_id);

CREATE POLICY "Members can view roles in their organizations"
  ON public.user_roles FOR SELECT TO authenticated
  USING (public.is_org_member(auth.uid(), organization_id));

CREATE POLICY "Owners can manage roles"
  ON public.user_roles FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), organization_id, 'owner'))
  WITH CHECK (public.has_role(auth.uid(), organization_id, 'owner'));

CREATE POLICY "Admins can grant non-owner roles"
  ON public.user_roles FOR INSERT TO authenticated
  WITH CHECK (public.has_role(auth.uid(), organization_id, 'admin') AND role <> 'owner');

CREATE POLICY "Members can view businesses"
  ON public.businesses FOR SELECT TO authenticated
  USING (public.is_org_member(auth.uid(), organization_id));

CREATE POLICY "Managers can manage businesses"
  ON public.businesses FOR ALL TO authenticated
  USING (public.is_org_manager(auth.uid(), organization_id))
  WITH CHECK (public.is_org_manager(auth.uid(), organization_id));

CREATE POLICY "Members can view branches"
  ON public.branches FOR SELECT TO authenticated
  USING (public.is_org_member(auth.uid(), organization_id));

CREATE POLICY "Managers can manage branches"
  ON public.branches FOR ALL TO authenticated
  USING (public.is_org_manager(auth.uid(), organization_id))
  WITH CHECK (public.is_org_manager(auth.uid(), organization_id));

CREATE POLICY "Members can view invitations"
  ON public.organization_invitations FOR SELECT TO authenticated
  USING (public.is_org_member(auth.uid(), organization_id));

CREATE POLICY "Managers can manage invitations"
  ON public.organization_invitations FOR ALL TO authenticated
  USING (public.is_org_manager(auth.uid(), organization_id))
  WITH CHECK (public.is_org_manager(auth.uid(), organization_id));

CREATE POLICY "Members can view audit logs"
  ON public.audit_logs FOR SELECT TO authenticated
  USING (public.is_org_member(auth.uid(), organization_id));

CREATE POLICY "Members can write audit logs"
  ON public.audit_logs FOR INSERT TO authenticated
  WITH CHECK (public.is_org_member(auth.uid(), organization_id));

CREATE POLICY "Signed-in users can read platform settings"
  ON public.platform_settings FOR SELECT TO authenticated
  USING (is_secret = false);

-- ============================== TRIGGERS =============================
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  INSERT INTO public.profiles (user_id, email, full_name)
  VALUES (NEW.id, NEW.email, COALESCE(NEW.raw_user_meta_data->>'full_name', ''))
  ON CONFLICT (user_id) DO NOTHING;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

CREATE TRIGGER set_organizations_updated_at BEFORE UPDATE ON public.organizations
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
CREATE TRIGGER set_profiles_updated_at BEFORE UPDATE ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
CREATE TRIGGER set_user_roles_updated_at BEFORE UPDATE ON public.user_roles
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
CREATE TRIGGER set_businesses_updated_at BEFORE UPDATE ON public.businesses
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
CREATE TRIGGER set_branches_updated_at BEFORE UPDATE ON public.branches
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
CREATE TRIGGER set_user_pins_updated_at BEFORE UPDATE ON public.user_pins
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
CREATE TRIGGER set_platform_settings_updated_at BEFORE UPDATE ON public.platform_settings
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- Helpful indexes
CREATE INDEX IF NOT EXISTS idx_user_roles_user ON public.user_roles(user_id);
CREATE INDEX IF NOT EXISTS idx_user_roles_org ON public.user_roles(organization_id);
CREATE INDEX IF NOT EXISTS idx_businesses_org ON public.businesses(organization_id);
CREATE INDEX IF NOT EXISTS idx_branches_business ON public.branches(business_id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_org_created ON public.audit_logs(organization_id, created_at DESC);