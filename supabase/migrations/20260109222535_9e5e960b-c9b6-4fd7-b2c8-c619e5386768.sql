-- Fix RLS on pre-existing tables that have policies but RLS disabled

-- Enable RLS on organization_invitations
ALTER TABLE public.organization_invitations ENABLE ROW LEVEL SECURITY;

-- Enable RLS on organizations  
ALTER TABLE public.organizations ENABLE ROW LEVEL SECURITY;

-- Enable RLS on profiles
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;

-- Enable RLS on user_roles
ALTER TABLE public.user_roles ENABLE ROW LEVEL SECURITY;