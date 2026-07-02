-- Phase 1: Remove stale/duplicate invoice triggers and legacy function

-- 1. Drop the broken legacy trigger that references non-existent override_key column
DROP TRIGGER IF EXISTS trg_enforce_invoice_limit ON public.invoices;

-- 2. Drop the duplicate trigger (keep only enforce_invoice_count_limit_trigger)
DROP TRIGGER IF EXISTS trg_enforce_invoice_count ON public.invoices;

-- 3. Drop the broken legacy function
DROP FUNCTION IF EXISTS public.enforce_invoice_limit();

-- Phase 2: Clean up user_roles duplicate triggers

-- Drop all existing user limit triggers to normalize
DROP TRIGGER IF EXISTS trg_enforce_user_limit ON public.user_roles;
DROP TRIGGER IF EXISTS enforce_user_limit_trigger ON public.user_roles;

-- Recreate a single canonical trigger
CREATE TRIGGER enforce_user_limit_trigger
  BEFORE INSERT ON public.user_roles
  FOR EACH ROW
  EXECUTE FUNCTION public.enforce_user_limit();