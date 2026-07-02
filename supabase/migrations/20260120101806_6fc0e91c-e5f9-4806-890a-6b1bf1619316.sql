-- Phase 1: ERP Role-Based Access - Database Schema Updates

-- 1.1 Create departments table first (needed for foreign key)
CREATE TABLE public.departments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  business_id UUID REFERENCES public.businesses(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  code TEXT,
  description TEXT,
  manager_id UUID, -- Will add FK after employees is updated
  parent_department_id UUID REFERENCES public.departments(id),
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- 1.2 Add new columns to employees table
ALTER TABLE public.employees 
ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES auth.users(id),
ADD COLUMN IF NOT EXISTS manager_id UUID REFERENCES public.employees(id),
ADD COLUMN IF NOT EXISTS department_id UUID REFERENCES public.departments(id);

-- 1.3 Add foreign key for department manager after employees table is updated
ALTER TABLE public.departments 
ADD CONSTRAINT departments_manager_id_fkey 
FOREIGN KEY (manager_id) REFERENCES public.employees(id);

-- 1.4 Create indexes for performance
CREATE INDEX IF NOT EXISTS idx_employees_user_id ON public.employees(user_id);
CREATE INDEX IF NOT EXISTS idx_employees_manager_id ON public.employees(manager_id);
CREATE INDEX IF NOT EXISTS idx_employees_department_id ON public.employees(department_id);
CREATE INDEX IF NOT EXISTS idx_departments_organization_id ON public.departments(organization_id);
CREATE INDEX IF NOT EXISTS idx_departments_manager_id ON public.departments(manager_id);

-- 1.5 Enable RLS on departments
ALTER TABLE public.departments ENABLE ROW LEVEL SECURITY;

-- 1.6 RLS policies for departments
CREATE POLICY "Users can view departments in their organization"
ON public.departments FOR SELECT
USING (
  organization_id IN (
    SELECT organization_id FROM public.profiles WHERE id = auth.uid()
  )
);

CREATE POLICY "Admins can manage departments"
ON public.departments FOR ALL
USING (
  public.has_org_role(auth.uid(), organization_id, 'admin'::app_role)
  OR public.has_org_role(auth.uid(), organization_id, 'owner'::app_role)
);

-- 1.7 Add trigger for updated_at on departments
CREATE TRIGGER update_departments_updated_at
BEFORE UPDATE ON public.departments
FOR EACH ROW
EXECUTE FUNCTION public.update_updated_at_column();

-- 1.8 Create a function to get current employee record for logged-in user
CREATE OR REPLACE FUNCTION public.get_current_employee(_organization_id UUID DEFAULT NULL)
RETURNS UUID
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT id FROM public.employees 
  WHERE user_id = auth.uid() 
  AND (_organization_id IS NULL OR organization_id = _organization_id)
  LIMIT 1;
$$;

-- 1.9 Create function to check if user is manager of an employee
CREATE OR REPLACE FUNCTION public.is_manager_of(_employee_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.employees e
    WHERE e.id = _employee_id
    AND e.manager_id IN (
      SELECT id FROM public.employees WHERE user_id = auth.uid()
    )
  );
$$;

-- 1.10 Create function to check if user is HR/Admin in an organization
CREATE OR REPLACE FUNCTION public.is_hr_user(_organization_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT public.has_org_role(auth.uid(), _organization_id, 'admin'::app_role) 
  OR public.has_org_role(auth.uid(), _organization_id, 'owner'::app_role);
$$;

-- 1.11 Update leave_requests RLS to allow managers to see their team's requests
DROP POLICY IF EXISTS "Users can view leave requests in their organization" ON public.leave_requests;

CREATE POLICY "Users can view own and team leave requests"
ON public.leave_requests FOR SELECT
USING (
  -- Can see own requests (user is linked to this employee)
  employee_id IN (SELECT id FROM public.employees WHERE user_id = auth.uid())
  -- Or is manager of the employee
  OR public.is_manager_of(employee_id)
  -- Or is admin/HR in the organization
  OR public.is_hr_user(organization_id)
  -- Or same organization and approved (for calendar visibility)
  OR (
    status = 'approved' 
    AND organization_id IN (
      SELECT organization_id FROM public.profiles WHERE id = auth.uid()
    )
  )
);

-- 1.12 Add policy for managers to update (approve/reject) leave requests
CREATE POLICY "Managers and HR can update leave requests"
ON public.leave_requests FOR UPDATE
USING (
  public.is_manager_of(employee_id)
  OR public.is_hr_user(organization_id)
)
WITH CHECK (
  public.is_manager_of(employee_id)
  OR public.is_hr_user(organization_id)
);

-- 1.13 Create function to get employees reporting to a manager
CREATE OR REPLACE FUNCTION public.get_direct_reports(_manager_employee_id UUID)
RETURNS SETOF UUID
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT id FROM public.employees WHERE manager_id = _manager_employee_id;
$$;

-- 1.14 Create function to get all subordinates (recursive)
CREATE OR REPLACE FUNCTION public.get_all_subordinates(_manager_employee_id UUID)
RETURNS SETOF UUID
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH RECURSIVE subordinates AS (
    SELECT id FROM public.employees WHERE manager_id = _manager_employee_id
    UNION ALL
    SELECT e.id FROM public.employees e
    INNER JOIN subordinates s ON e.manager_id = s.id
  )
  SELECT id FROM subordinates;
$$;