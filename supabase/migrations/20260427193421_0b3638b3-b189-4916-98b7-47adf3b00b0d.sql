-- Remove legacy org-only POS manager PIN overloads so all manager PIN operations are company-scoped.
DROP FUNCTION IF EXISTS public.set_manager_pin(uuid, uuid, text);
DROP FUNCTION IF EXISTS public.verify_manager_pin(uuid, uuid, text);