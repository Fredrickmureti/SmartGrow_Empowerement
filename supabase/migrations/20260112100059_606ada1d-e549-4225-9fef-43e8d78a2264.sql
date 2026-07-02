-- Allow organization members to view profiles of users in the same organization
-- This fixes the Team page "Failed to load data" issue

-- Create a security definer function to check if users share an organization
CREATE OR REPLACE FUNCTION public.users_share_organization(_user_id_1 uuid, _user_id_2 uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 
    FROM user_roles ur1
    JOIN user_roles ur2 ON ur1.organization_id = ur2.organization_id
    WHERE ur1.user_id = _user_id_1 
      AND ur2.user_id = _user_id_2
      AND ur1.is_active = true
      AND ur2.is_active = true
  )
$$;

-- Drop existing restrictive policy if it exists
DROP POLICY IF EXISTS "Users can view own profile" ON profiles;

-- Create new policies for profiles
-- Users can view their own profile
CREATE POLICY "Users can view own profile" 
ON profiles FOR SELECT 
USING (auth.uid() = user_id);

-- Users can view profiles of team members in the same organization
CREATE POLICY "Users can view team member profiles" 
ON profiles FOR SELECT 
USING (public.users_share_organization(auth.uid(), user_id));

-- Users can update their own profile
DROP POLICY IF EXISTS "Users can update own profile" ON profiles;
CREATE POLICY "Users can update own profile" 
ON profiles FOR UPDATE 
USING (auth.uid() = user_id);

-- Users can insert their own profile
DROP POLICY IF EXISTS "Users can insert own profile" ON profiles;
CREATE POLICY "Users can insert own profile" 
ON profiles FOR INSERT 
WITH CHECK (auth.uid() = user_id);