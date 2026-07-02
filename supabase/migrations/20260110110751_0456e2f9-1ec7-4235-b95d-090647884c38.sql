-- Create platform_admins table to designate super admins (SaaS owners)
CREATE TABLE public.platform_admins (
    id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    granted_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
    granted_by UUID REFERENCES auth.users(id),
    is_active BOOLEAN NOT NULL DEFAULT true,
    notes TEXT,
    UNIQUE(user_id)
);

-- Enable RLS
ALTER TABLE public.platform_admins ENABLE ROW LEVEL SECURITY;

-- Create a security definer function to check if user is platform admin
CREATE OR REPLACE FUNCTION public.is_platform_admin(_user_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
    SELECT EXISTS (
        SELECT 1
        FROM public.platform_admins
        WHERE user_id = _user_id
          AND is_active = true
    )
$$;

-- Platform admins can read their own records
CREATE POLICY "Platform admins can read their own record"
ON public.platform_admins
FOR SELECT
USING (auth.uid() = user_id);

-- Only platform admins can view all platform admin records
CREATE POLICY "Platform admins can view all admins"
ON public.platform_admins
FOR SELECT
USING (public.is_platform_admin(auth.uid()));

-- Create an index for better performance
CREATE INDEX idx_platform_admins_user_id ON public.platform_admins(user_id) WHERE is_active = true;

-- Insert the current user as the first platform admin (SaaS owner)
INSERT INTO public.platform_admins (user_id, notes)
SELECT id, 'Initial SaaS owner'
FROM auth.users
WHERE email = 'fredrickmureti612@gmail.com'
ON CONFLICT (user_id) DO NOTHING;