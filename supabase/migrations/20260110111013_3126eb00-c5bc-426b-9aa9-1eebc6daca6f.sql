-- Add RLS policies for platform admins to view cross-organization data

-- Organizations: Platform admins can view all
CREATE POLICY "Platform admins can view all organizations"
ON public.organizations
FOR SELECT
USING (public.is_platform_admin(auth.uid()));

-- Profiles: Platform admins can view all
CREATE POLICY "Platform admins can view all profiles"
ON public.profiles
FOR SELECT
USING (public.is_platform_admin(auth.uid()));

-- Invoices: Platform admins can view all
CREATE POLICY "Platform admins can view all invoices"
ON public.invoices
FOR SELECT
USING (public.is_platform_admin(auth.uid()));

-- Expenses: Platform admins can view all
CREATE POLICY "Platform admins can view all expenses"
ON public.expenses
FOR SELECT
USING (public.is_platform_admin(auth.uid()));

-- User Roles: Platform admins can view all
CREATE POLICY "Platform admins can view all user roles"
ON public.user_roles
FOR SELECT
USING (public.is_platform_admin(auth.uid()));