-- Fix broken RLS policies on scheduled_reports table

-- Drop existing broken policy
DROP POLICY IF EXISTS "Users can manage their org scheduled reports" ON public.scheduled_reports;

-- Create correct SELECT policy
CREATE POLICY "Users can view scheduled reports in their organization"
ON public.scheduled_reports
FOR SELECT
TO authenticated
USING (
  organization_id IN (
    SELECT user_roles.organization_id
    FROM user_roles
    WHERE user_roles.user_id = auth.uid()
      AND user_roles.is_active = true
  )
);

-- Create correct INSERT policy
CREATE POLICY "Users can create scheduled reports in their organization"
ON public.scheduled_reports
FOR INSERT
TO authenticated
WITH CHECK (
  organization_id IN (
    SELECT user_roles.organization_id
    FROM user_roles
    WHERE user_roles.user_id = auth.uid()
      AND user_roles.is_active = true
  )
);

-- Create correct UPDATE policy
CREATE POLICY "Users can update scheduled reports in their organization"
ON public.scheduled_reports
FOR UPDATE
TO authenticated
USING (
  organization_id IN (
    SELECT user_roles.organization_id
    FROM user_roles
    WHERE user_roles.user_id = auth.uid()
      AND user_roles.is_active = true
  )
);

-- Create correct DELETE policy
CREATE POLICY "Users can delete scheduled reports in their organization"
ON public.scheduled_reports
FOR DELETE
TO authenticated
USING (
  organization_id IN (
    SELECT user_roles.organization_id
    FROM user_roles
    WHERE user_roles.user_id = auth.uid()
      AND user_roles.is_active = true
  )
);