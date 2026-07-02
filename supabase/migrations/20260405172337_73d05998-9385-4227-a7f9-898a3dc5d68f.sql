-- Remove duplicate/legacy user limit triggers, keep only enforce_user_count_limit_trigger

-- Drop legacy trigger referencing subscription_plans (wrong table)
DROP TRIGGER IF EXISTS enforce_user_limit_trigger ON public.user_roles;

-- Drop duplicate that calls same function as the canonical one
DROP TRIGGER IF EXISTS trg_enforce_user_count ON public.user_roles;

-- Drop redundant invite-limit check (overlaps with canonical enforcement)
DROP TRIGGER IF EXISTS trg_check_user_limit_before_invite ON public.user_roles;

-- Drop the legacy enforce_user_limit function (references subscription_plans which doesn't exist)
DROP FUNCTION IF EXISTS public.enforce_user_limit();

-- Drop the redundant check function
DROP FUNCTION IF EXISTS public.check_user_limit_before_invite();