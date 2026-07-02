-- Enable RLS on organizations and user_roles tables (they already have policies but RLS is disabled)
ALTER TABLE public.organizations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_roles ENABLE ROW LEVEL SECURITY;