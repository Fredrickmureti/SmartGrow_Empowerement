
-- ============================================================================
-- Statutory Schemes & Components — enterprise contribution model
-- Replaces string-convention binding (payroll_rule_code ↔ sum_rule.<code>.<side>)
-- with a referential model that scales to every localization pack.
-- ============================================================================

-- ---- Enums ------------------------------------------------------------------
DO $$ BEGIN
  CREATE TYPE public.statutory_component_type AS ENUM ('mandatory','voluntary','employer','top_up');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE public.statutory_component_party AS ENUM ('employee','employer');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE public.statutory_reporting_side AS ENUM ('employee','employer','total','taxable','count');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ---- statutory_schemes ------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.statutory_schemes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  pack_id UUID REFERENCES public.localization_packs(id) ON DELETE CASCADE,
  country_code TEXT NOT NULL,
  code TEXT NOT NULL,
  display_name TEXT NOT NULL,
  authority_id UUID REFERENCES public.statutory_authorities(id) ON DELETE SET NULL,
  description TEXT,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (country_code, code)
);

GRANT SELECT ON public.statutory_schemes TO authenticated, anon;
GRANT ALL ON public.statutory_schemes TO service_role;
ALTER TABLE public.statutory_schemes ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Statutory schemes are readable by anyone"
  ON public.statutory_schemes FOR SELECT USING (true);
CREATE POLICY "Only platform admins can manage schemes"
  ON public.statutory_schemes FOR ALL
  USING (public.has_role(auth.uid(), 'platform_admin'))
  WITH CHECK (public.has_role(auth.uid(), 'platform_admin'));

-- ---- statutory_scheme_components -------------------------------------------
CREATE TABLE IF NOT EXISTS public.statutory_scheme_components (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  scheme_id UUID NOT NULL REFERENCES public.statutory_schemes(id) ON DELETE CASCADE,
  code TEXT NOT NULL,
  display_name TEXT NOT NULL,
  component_type public.statutory_component_type NOT NULL,
  party public.statutory_component_party NOT NULL,
  rule_code TEXT NOT NULL,
  gl_liability_role TEXT,
  gl_expense_role TEXT,
  tax_treatment TEXT,
  parameters JSONB NOT NULL DEFAULT '{}'::jsonb,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (scheme_id, code),
  UNIQUE (scheme_id, rule_code, party)
);
CREATE INDEX IF NOT EXISTS idx_scheme_components_rule_code
  ON public.statutory_scheme_components(rule_code);

GRANT SELECT ON public.statutory_scheme_components TO authenticated, anon;
GRANT ALL ON public.statutory_scheme_components TO service_role;
ALTER TABLE public.statutory_scheme_components ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Scheme components are readable by anyone"
  ON public.statutory_scheme_components FOR SELECT USING (true);
CREATE POLICY "Only platform admins can manage scheme components"
  ON public.statutory_scheme_components FOR ALL
  USING (public.has_role(auth.uid(), 'platform_admin'))
  WITH CHECK (public.has_role(auth.uid(), 'platform_admin'));

-- ---- statutory_reporting_bindings ------------------------------------------
CREATE TABLE IF NOT EXISTS public.statutory_reporting_bindings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  scheme_component_id UUID NOT NULL REFERENCES public.statutory_scheme_components(id) ON DELETE CASCADE,
  return_template_code TEXT NOT NULL,
  column_key TEXT NOT NULL,
  side public.statutory_reporting_side NOT NULL DEFAULT 'employee',
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (return_template_code, column_key, side)
);
CREATE INDEX IF NOT EXISTS idx_reporting_bindings_template
  ON public.statutory_reporting_bindings(return_template_code);
CREATE INDEX IF NOT EXISTS idx_reporting_bindings_component
  ON public.statutory_reporting_bindings(scheme_component_id);

GRANT SELECT ON public.statutory_reporting_bindings TO authenticated, anon;
GRANT ALL ON public.statutory_reporting_bindings TO service_role;
ALTER TABLE public.statutory_reporting_bindings ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Reporting bindings are readable by anyone"
  ON public.statutory_reporting_bindings FOR SELECT USING (true);
CREATE POLICY "Only platform admins can manage reporting bindings"
  ON public.statutory_reporting_bindings FOR ALL
  USING (public.has_role(auth.uid(), 'platform_admin'))
  WITH CHECK (public.has_role(auth.uid(), 'platform_admin'));

-- ---- FKs on existing canonical tables --------------------------------------
ALTER TABLE public.custom_deduction_types
  ADD COLUMN IF NOT EXISTS scheme_component_id UUID
    REFERENCES public.statutory_scheme_components(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_custom_deduction_types_scheme_component
  ON public.custom_deduction_types(scheme_component_id);

ALTER TABLE public.payslip_lines
  ADD COLUMN IF NOT EXISTS scheme_component_id UUID
    REFERENCES public.statutory_scheme_components(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_payslip_lines_scheme_component
  ON public.payslip_lines(scheme_component_id);

-- ---- updated_at triggers ----------------------------------------------------
CREATE TRIGGER set_statutory_schemes_updated_at
  BEFORE UPDATE ON public.statutory_schemes
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE TRIGGER set_statutory_scheme_components_updated_at
  BEFORE UPDATE ON public.statutory_scheme_components
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE TRIGGER set_statutory_reporting_bindings_updated_at
  BEFORE UPDATE ON public.statutory_reporting_bindings
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
