DROP TRIGGER IF EXISTS trg_provision_default_inventory_for_branch ON public.branches;
DROP FUNCTION IF EXISTS public.provision_default_inventory_for_branch();