
-- ============================================================
-- P0 Security Fix: Tighten RLS policies on sensitive HR tables
-- ============================================================

-- 1. PUBLIC HOLIDAYS: Replace overly broad ALL policy with role-restricted CUD
-- Drop the existing overly broad policy that allows ANY org member to manage holidays
DROP POLICY IF EXISTS "Users can manage public holidays in their organization" ON public.public_holidays;

-- Create restricted INSERT policy (admin/owner/super_admin only)
CREATE POLICY "HR admins can insert public holidays"
ON public.public_holidays
FOR INSERT
WITH CHECK (
  EXISTS (
    SELECT 1 FROM user_roles
    WHERE user_roles.user_id = auth.uid()
      AND user_roles.organization_id = public_holidays.organization_id
      AND user_roles.role IN ('super_admin', 'owner', 'admin')
      AND user_roles.is_active = true
  )
);

-- Create restricted UPDATE policy
CREATE POLICY "HR admins can update public holidays"
ON public.public_holidays
FOR UPDATE
USING (
  EXISTS (
    SELECT 1 FROM user_roles
    WHERE user_roles.user_id = auth.uid()
      AND user_roles.organization_id = public_holidays.organization_id
      AND user_roles.role IN ('super_admin', 'owner', 'admin')
      AND user_roles.is_active = true
  )
);

-- Create restricted DELETE policy
CREATE POLICY "HR admins can delete public holidays"
ON public.public_holidays
FOR DELETE
USING (
  EXISTS (
    SELECT 1 FROM user_roles
    WHERE user_roles.user_id = auth.uid()
      AND user_roles.organization_id = public_holidays.organization_id
      AND user_roles.role IN ('super_admin', 'owner', 'admin')
      AND user_roles.is_active = true
  )
);

-- SELECT stays as-is (all org members should see holidays)

-- 2. EMPLOYEE CONTRACTS: Restrict SELECT to HR/payroll roles + contract owner
DROP POLICY IF EXISTS "Users can view contracts in their organization" ON public.employee_contracts;

CREATE POLICY "HR and payroll can view all contracts"
ON public.employee_contracts
FOR SELECT
USING (
  -- The employee themselves can view their own contract
  (employee_id IN (
    SELECT e.id FROM employees e WHERE e.user_id = auth.uid()
  ))
  OR
  -- HR/admin/payroll roles can view all contracts in their org
  (EXISTS (
    SELECT 1 FROM user_roles
    WHERE user_roles.user_id = auth.uid()
      AND user_roles.organization_id = employee_contracts.organization_id
      AND user_roles.role IN ('super_admin', 'owner', 'admin', 'accountant')
      AND user_roles.is_active = true
  ))
);

-- 3. ATTENDANCE: Tighten INSERT to self-entry OR admin roles
DROP POLICY IF EXISTS "Staff can insert attendance" ON public.attendance;

CREATE POLICY "Self or admin can insert attendance"
ON public.attendance
FOR INSERT
WITH CHECK (
  -- Self-entry: employee inserting their own attendance
  (employee_id IN (
    SELECT e.id FROM employees e WHERE e.user_id = auth.uid()
  ))
  OR
  -- Admin/HR can insert for anyone in their org
  (EXISTS (
    SELECT 1 FROM user_roles
    WHERE user_roles.user_id = auth.uid()
      AND user_roles.organization_id = attendance.organization_id
      AND user_roles.role IN ('super_admin', 'owner', 'admin')
      AND user_roles.is_active = true
  ))
);
