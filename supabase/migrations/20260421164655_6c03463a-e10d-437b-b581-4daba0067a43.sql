
-- ============================================================
-- 1. INVOICE NUMBERING — per-business
-- ============================================================
CREATE OR REPLACE FUNCTION public.get_next_invoice_number(_org_id uuid, _business_id uuid DEFAULT NULL)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  next_num integer;
  prefix text;
BEGIN
  IF _business_id IS NULL THEN
    RAISE EXCEPTION 'business_id is required for invoice numbering (multi-company isolation)';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('invoices_' || _business_id::text));

  SELECT COALESCE(MAX(
    CASE WHEN invoice_number ~ '\d+$'
      THEN CAST(substring(invoice_number FROM '\d+$') AS integer)
      ELSE 0
    END
  ), 0) + 1
  INTO next_num
  FROM public.invoices
  WHERE organization_id = _org_id
    AND business_id = _business_id;

  SELECT COALESCE(b.invoice_prefix, 'INV-')
  INTO prefix
  FROM public.businesses b
  WHERE b.id = _business_id;

  prefix := COALESCE(prefix, 'INV-');

  RETURN prefix || LPAD(next_num::text, 5, '0');
END;
$function$;

-- ============================================================
-- 2. JE NUMBERING — per-business
-- ============================================================
-- Drop the org-wide unique constraint; replace with business-scoped uniqueness.
ALTER TABLE public.journal_entries
  DROP CONSTRAINT IF EXISTS journal_entries_organization_id_entry_number_key;

CREATE UNIQUE INDEX IF NOT EXISTS journal_entries_business_entry_number_key
  ON public.journal_entries (business_id, entry_number);

-- Rewrite generator to be business-scoped.
CREATE OR REPLACE FUNCTION public.generate_next_je_number(_org_id uuid, _business_id uuid DEFAULT NULL)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_num INT;
  v_current_max INT;
BEGIN
  IF _business_id IS NULL THEN
    RAISE EXCEPTION 'business_id is required for JE numbering (multi-company isolation)';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('je_' || _business_id::text));

  -- Self-heal against any pre-existing higher JE numbers for this business.
  SELECT COALESCE(MAX(
    CASE
      WHEN entry_number ~ '^JE-[0-9]+$' THEN CAST(SUBSTRING(entry_number FROM 4) AS INT)
      ELSE 0
    END
  ), 0)
  INTO v_current_max
  FROM public.journal_entries
  WHERE business_id = _business_id;

  INSERT INTO public.je_number_sequences (organization_id, business_id, last_number)
  VALUES (_org_id, _business_id, v_current_max)
  ON CONFLICT (business_id)
  DO UPDATE SET last_number = GREATEST(public.je_number_sequences.last_number, EXCLUDED.last_number);

  UPDATE public.je_number_sequences
     SET last_number = last_number + 1
   WHERE business_id = _business_id
   RETURNING last_number INTO v_num;

  RETURN 'JE-' || LPAD(v_num::TEXT, 5, '0');
END;
$function$;

-- ============================================================
-- 3. EMPLOYEE NUMBERING — per-business
-- ============================================================
CREATE OR REPLACE FUNCTION public.get_next_employee_number(_org_id uuid, _business_id uuid DEFAULT NULL)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  next_num INTEGER;
BEGIN
  IF _business_id IS NULL THEN
    -- Backward-compatible path: org-wide numbering (deprecated, will be removed).
    SELECT COALESCE(MAX(CAST(SUBSTRING(employee_number FROM '[0-9]+$') AS INTEGER)), 0) + 1
      INTO next_num
      FROM public.employees
     WHERE organization_id = _org_id;
  ELSE
    PERFORM pg_advisory_xact_lock(hashtext('emp_' || _business_id::text));
    SELECT COALESCE(MAX(CAST(SUBSTRING(employee_number FROM '[0-9]+$') AS INTEGER)), 0) + 1
      INTO next_num
      FROM public.employees
     WHERE business_id = _business_id;
  END IF;

  RETURN 'EMP-' || LPAD(next_num::TEXT, 4, '0');
END;
$function$;

-- Add per-business uniqueness alongside the existing org-wide one (kept for
-- backward compat until callers are migrated; safe because emp numbers were
-- already unique per org).
CREATE UNIQUE INDEX IF NOT EXISTS employees_business_employee_number_key
  ON public.employees (business_id, employee_number)
  WHERE business_id IS NOT NULL;

-- ============================================================
-- 4. RLS — restrict the "service role" policies to the service_role.
-- These were intentionally for backend automation but were written as
-- USING (true)/WITH CHECK (true), which the linter flags as permissive.
-- Restricting them to the service_role role makes intent explicit.
-- ============================================================
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT n.nspname AS schemaname, c.relname AS tablename, p.polname
    FROM pg_policy p
    JOIN pg_class c ON c.oid = p.polrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND p.polcmd IN ('w','a')
      AND p.polname ILIKE 'Service role can%'
  LOOP
    EXECUTE format('ALTER POLICY %I ON %I.%I TO service_role',
                   r.polname, r.schemaname, r.tablename);
  END LOOP;
END $$;
