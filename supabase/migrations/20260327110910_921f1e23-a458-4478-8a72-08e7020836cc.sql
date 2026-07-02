-- Fix employee record: update first_name/last_name from profile data
-- This is a data fix for employee fb20303b-0316-4a72-ae78-18300936e2c7
-- whose first_name was auto-populated from email prefix instead of real name

UPDATE public.employees 
SET first_name = 'Fredrick', last_name = 'Mureti', updated_at = now()
WHERE id = 'fb20303b-0316-4a72-ae78-18300936e2c7' 
  AND first_name = 'fredrickmureti612';

-- Create a trigger function to auto-sync employee names from profiles
-- when a profile's full_name is updated
CREATE OR REPLACE FUNCTION public.sync_employee_name_from_profile()
RETURNS TRIGGER AS $$
BEGIN
  -- When profile full_name changes, update linked employee record
  IF NEW.full_name IS NOT NULL AND NEW.full_name != '' AND 
     (OLD.full_name IS DISTINCT FROM NEW.full_name) THEN
    UPDATE public.employees
    SET 
      first_name = split_part(NEW.full_name, ' ', 1),
      last_name = CASE 
        WHEN position(' ' in NEW.full_name) > 0 
        THEN substring(NEW.full_name from position(' ' in NEW.full_name) + 1)
        ELSE ''
      END,
      updated_at = now()
    WHERE user_id = NEW.user_id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- Create the trigger
DROP TRIGGER IF EXISTS sync_employee_name_on_profile_update ON public.profiles;
CREATE TRIGGER sync_employee_name_on_profile_update
  AFTER UPDATE OF full_name ON public.profiles
  FOR EACH ROW
  EXECUTE FUNCTION public.sync_employee_name_from_profile();