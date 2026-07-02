-- Fix: ON CONFLICT (business_id, lower(name)) in seed_app_data could not match the
-- existing partial unique index on departments (predicate WHERE business_id IS NOT NULL),
-- causing 42P10 when installing employees/hr apps. Replace it with a non-partial
-- unique index so ON CONFLICT inference works for any caller that conflict-targets
-- (business_id, lower(name)).

-- Defensive: ensure no NULL business_id rows exist (would block index creation).
-- (departments table is currently empty per audit; this is a safety net for future.)
DELETE FROM public.departments WHERE business_id IS NULL;

ALTER TABLE public.departments ALTER COLUMN business_id SET NOT NULL;

DROP INDEX IF EXISTS public.departments_business_name_unique;

CREATE UNIQUE INDEX departments_business_name_unique
  ON public.departments (business_id, lower(name));