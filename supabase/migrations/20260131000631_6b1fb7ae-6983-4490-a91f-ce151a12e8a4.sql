-- Fix infinite recursion in spreadsheet RLS policies
-- The issue: spreadsheets policy queries spreadsheet_shares, which queries spreadsheets

-- Step 1: Drop the problematic policies
DROP POLICY IF EXISTS "Token holders can view shared spreadsheets" ON public.spreadsheets;
DROP POLICY IF EXISTS "Org members can manage shares" ON public.spreadsheet_shares;

-- Step 2: Create a security definer function to check spreadsheet access via shares
-- This breaks the recursion by using SECURITY DEFINER to bypass RLS
CREATE OR REPLACE FUNCTION public.has_spreadsheet_share_access(spreadsheet_uuid uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM spreadsheet_shares
    WHERE spreadsheet_id = spreadsheet_uuid
      AND access_token IS NOT NULL
      AND (expires_at IS NULL OR expires_at > now())
  )
$$;

-- Step 3: Create a security definer function to check if user can manage shares
-- Uses user_roles directly (not spreadsheets) to avoid recursion
CREATE OR REPLACE FUNCTION public.can_manage_spreadsheet_shares(spreadsheet_uuid uuid, user_uuid uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM spreadsheets s
    JOIN user_roles ur ON ur.organization_id = s.organization_id
    WHERE s.id = spreadsheet_uuid
      AND ur.user_id = user_uuid
      AND ur.is_active = true
  )
$$;

-- Step 4: Recreate spreadsheets policy using the function
CREATE POLICY "Token holders can view shared spreadsheets"
ON public.spreadsheets
FOR SELECT
TO anon, authenticated
USING (public.has_spreadsheet_share_access(id));

-- Step 5: Recreate spreadsheet_shares policy using the function
CREATE POLICY "Org members can manage shares"
ON public.spreadsheet_shares
FOR ALL
TO authenticated
USING (public.can_manage_spreadsheet_shares(spreadsheet_id, auth.uid()))
WITH CHECK (public.can_manage_spreadsheet_shares(spreadsheet_id, auth.uid()));