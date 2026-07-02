-- Phase 2: Add user_type to user_roles
ALTER TABLE public.user_roles 
ADD COLUMN IF NOT EXISTS user_type text NOT NULL DEFAULT 'internal';

-- Add check constraint via trigger (not CHECK to avoid immutability issues)
CREATE OR REPLACE FUNCTION public.validate_user_type()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.user_type NOT IN ('internal', 'portal') THEN
    RAISE EXCEPTION 'user_type must be internal or portal';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = public;

DROP TRIGGER IF EXISTS validate_user_type_trigger ON public.user_roles;
CREATE TRIGGER validate_user_type_trigger
  BEFORE INSERT OR UPDATE ON public.user_roles
  FOR EACH ROW
  EXECUTE FUNCTION public.validate_user_type();

-- Phase 3: Add user access status to employees
ALTER TABLE public.employees
ADD COLUMN IF NOT EXISTS user_access_status text NOT NULL DEFAULT 'none';

CREATE OR REPLACE FUNCTION public.validate_user_access_status()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.user_access_status NOT IN ('none', 'invited', 'active') THEN
    RAISE EXCEPTION 'user_access_status must be none, invited, or active';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = public;

DROP TRIGGER IF EXISTS validate_user_access_status_trigger ON public.employees;
CREATE TRIGGER validate_user_access_status_trigger
  BEFORE INSERT OR UPDATE ON public.employees
  FOR EACH ROW
  EXECUTE FUNCTION public.validate_user_access_status();

-- Phase 4: Add missing employee fields
ALTER TABLE public.employees
ADD COLUMN IF NOT EXISTS gender text,
ADD COLUMN IF NOT EXISTS date_of_birth date,
ADD COLUMN IF NOT EXISTS work_email text,
ADD COLUMN IF NOT EXISTS personal_phone text,
ADD COLUMN IF NOT EXISTS emergency_contact_name text,
ADD COLUMN IF NOT EXISTS emergency_contact_phone text,
ADD COLUMN IF NOT EXISTS branch_id uuid REFERENCES public.branches(id);

-- Create index on branch_id
CREATE INDEX IF NOT EXISTS idx_employees_branch_id ON public.employees(branch_id);
CREATE INDEX IF NOT EXISTS idx_employees_user_access_status ON public.employees(user_access_status);

-- Create security definer function to get user_type
CREATE OR REPLACE FUNCTION public.get_user_type(_user_id uuid, _org_id uuid)
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT user_type
  FROM public.user_roles
  WHERE user_id = _user_id
    AND organization_id = _org_id
  LIMIT 1;
$$;

-- Auto-update user_access_status when user_id is linked/unlinked
CREATE OR REPLACE FUNCTION public.sync_employee_user_access_status()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.user_id IS NOT NULL AND (OLD.user_id IS NULL OR OLD.user_id != NEW.user_id) THEN
    NEW.user_access_status = 'active';
  ELSIF NEW.user_id IS NULL AND OLD.user_id IS NOT NULL THEN
    NEW.user_access_status = 'none';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = public;

DROP TRIGGER IF EXISTS sync_employee_user_access_trigger ON public.employees;
CREATE TRIGGER sync_employee_user_access_trigger
  BEFORE UPDATE ON public.employees
  FOR EACH ROW
  EXECUTE FUNCTION public.sync_employee_user_access_status();