-- Data repair: Fix Bob Doe's employee record to link to correct auth user ID
-- profiles.id = 69425817-... but profiles.user_id (auth.users.id) = 0681e1a1-...
-- The employee record should reference auth.users.id, not profiles.id

-- First, fix any employees that were incorrectly linked to profiles.id instead of profiles.user_id
-- This updates employees where user_id matches a profiles.id but NOT a profiles.user_id
UPDATE employees e
SET user_id = p.user_id
FROM profiles p
WHERE e.user_id = p.id
  AND p.id != p.user_id
  AND NOT EXISTS (
    SELECT 1 FROM employees e2
    WHERE e2.user_id = p.user_id
      AND e2.organization_id = e.organization_id
      AND e2.id != e.id
  );

-- Specifically fix Bob Doe's record if still NULL
UPDATE employees
SET user_id = '0681e1a1-ea7a-48c9-b7b8-49e5fefe7100'
WHERE id = '9aa1afed-3b02-4af5-bd6c-2349cb6eb17f'
  AND user_id IS NULL;

-- Add unique constraint to prevent duplicate user-employee links per org
-- (only if not already present)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'employees_user_id_organization_id_unique'
  ) THEN
    ALTER TABLE employees
      ADD CONSTRAINT employees_user_id_organization_id_unique
      UNIQUE (user_id, organization_id);
  END IF;
END $$;