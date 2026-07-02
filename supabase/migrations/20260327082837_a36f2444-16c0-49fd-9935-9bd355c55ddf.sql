
-- Phase 1: Add missing employee master fields
ALTER TABLE public.employees
  ADD COLUMN IF NOT EXISTS marital_status text,
  ADD COLUMN IF NOT EXISTS address_line1 text,
  ADD COLUMN IF NOT EXISTS address_line2 text,
  ADD COLUMN IF NOT EXISTS city text,
  ADD COLUMN IF NOT EXISTS county text,
  ADD COLUMN IF NOT EXISTS postal_code text,
  ADD COLUMN IF NOT EXISTS country text,
  ADD COLUMN IF NOT EXISTS emergency_contact_relationship text;

-- Phase 1: Create country-agnostic statutory identifiers table
CREATE TABLE IF NOT EXISTS public.employee_statutory_identifiers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id uuid NOT NULL REFERENCES public.employees(id) ON DELETE CASCADE,
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  country_code text NOT NULL DEFAULT 'KE',
  identifier_type text NOT NULL,
  identifier_value text NOT NULL,
  effective_from date,
  effective_to date,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(employee_id, identifier_type, country_code)
);

-- Enable RLS
ALTER TABLE public.employee_statutory_identifiers ENABLE ROW LEVEL SECURITY;

-- RLS policies for employee_statutory_identifiers
CREATE POLICY "Users can view statutory identifiers in their org"
  ON public.employee_statutory_identifiers
  FOR SELECT
  TO authenticated
  USING (
    organization_id IN (
      SELECT organization_id FROM public.user_roles WHERE user_id = auth.uid()
    )
  );

CREATE POLICY "Users can manage statutory identifiers in their org"
  ON public.employee_statutory_identifiers
  FOR ALL
  TO authenticated
  USING (
    organization_id IN (
      SELECT organization_id FROM public.user_roles WHERE user_id = auth.uid()
    )
  )
  WITH CHECK (
    organization_id IN (
      SELECT organization_id FROM public.user_roles WHERE user_id = auth.uid()
    )
  );

-- Migrate existing Kenya statutory IDs to the new table
INSERT INTO public.employee_statutory_identifiers (employee_id, organization_id, country_code, identifier_type, identifier_value)
SELECT id, organization_id, 'KE', 'tax_pin', tax_pin
FROM public.employees WHERE tax_pin IS NOT NULL AND tax_pin != ''
ON CONFLICT (employee_id, identifier_type, country_code) DO NOTHING;

INSERT INTO public.employee_statutory_identifiers (employee_id, organization_id, country_code, identifier_type, identifier_value)
SELECT id, organization_id, 'KE', 'nssf_number', nssf_number
FROM public.employees WHERE nssf_number IS NOT NULL AND nssf_number != ''
ON CONFLICT (employee_id, identifier_type, country_code) DO NOTHING;

INSERT INTO public.employee_statutory_identifiers (employee_id, organization_id, country_code, identifier_type, identifier_value)
SELECT id, organization_id, 'KE', 'shif_number', shif_number
FROM public.employees WHERE shif_number IS NOT NULL AND shif_number != ''
ON CONFLICT (employee_id, identifier_type, country_code) DO NOTHING;

INSERT INTO public.employee_statutory_identifiers (employee_id, organization_id, country_code, identifier_type, identifier_value)
SELECT id, organization_id, 'KE', 'nhif_number', nhif_number
FROM public.employees WHERE nhif_number IS NOT NULL AND nhif_number != ''
ON CONFLICT (employee_id, identifier_type, country_code) DO NOTHING;

-- Add comment documenting deprecation plan for legacy columns
COMMENT ON COLUMN public.employees.tax_pin IS 'DEPRECATED: Use employee_statutory_identifiers table. Kept for backward compatibility.';
COMMENT ON COLUMN public.employees.nssf_number IS 'DEPRECATED: Use employee_statutory_identifiers table. Kept for backward compatibility.';
COMMENT ON COLUMN public.employees.nhif_number IS 'DEPRECATED: Use employee_statutory_identifiers table. Kept for backward compatibility.';
COMMENT ON COLUMN public.employees.shif_number IS 'DEPRECATED: Use employee_statutory_identifiers table. Kept for backward compatibility.';
