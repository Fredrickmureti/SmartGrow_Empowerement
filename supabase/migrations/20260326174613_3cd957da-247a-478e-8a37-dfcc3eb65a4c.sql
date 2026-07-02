
-- Phase 3: Employee Documents
CREATE TABLE public.employee_documents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  employee_id UUID NOT NULL REFERENCES public.employees(id) ON DELETE CASCADE,
  document_type TEXT NOT NULL DEFAULT 'other',
  name TEXT NOT NULL,
  description TEXT,
  file_path TEXT,
  file_name TEXT,
  file_size INTEGER,
  mime_type TEXT,
  uploaded_by UUID REFERENCES auth.users(id),
  expiry_date DATE,
  is_verified BOOLEAN DEFAULT false,
  verified_by UUID REFERENCES auth.users(id),
  verified_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.employee_documents ENABLE ROW LEVEL SECURITY;

CREATE POLICY "employee_documents_select" ON public.employee_documents FOR SELECT TO authenticated
  USING (user_has_module_permission(auth.uid(), organization_id, 'hr', 'read'));

CREATE POLICY "employee_documents_insert" ON public.employee_documents FOR INSERT TO authenticated
  WITH CHECK (user_has_module_permission(auth.uid(), organization_id, 'hr', 'write'));

CREATE POLICY "employee_documents_update" ON public.employee_documents FOR UPDATE TO authenticated
  USING (user_has_module_permission(auth.uid(), organization_id, 'hr', 'write'));

CREATE POLICY "employee_documents_delete" ON public.employee_documents FOR DELETE TO authenticated
  USING (user_has_module_permission(auth.uid(), organization_id, 'hr', 'delete'));

-- Phase 3: Onboarding Templates
CREATE TABLE public.onboarding_templates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT,
  template_type TEXT NOT NULL DEFAULT 'onboarding',
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.onboarding_templates ENABLE ROW LEVEL SECURITY;

CREATE POLICY "onboarding_templates_select" ON public.onboarding_templates FOR SELECT TO authenticated
  USING (user_has_module_permission(auth.uid(), organization_id, 'hr', 'read'));

CREATE POLICY "onboarding_templates_manage" ON public.onboarding_templates FOR ALL TO authenticated
  USING (user_has_module_permission(auth.uid(), organization_id, 'hr', 'write'));

CREATE TABLE public.onboarding_template_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  template_id UUID NOT NULL REFERENCES public.onboarding_templates(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT,
  category TEXT DEFAULT 'general',
  assigned_role TEXT,
  sort_order INTEGER DEFAULT 0,
  is_required BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.onboarding_template_items ENABLE ROW LEVEL SECURITY;

CREATE POLICY "onboarding_template_items_access" ON public.onboarding_template_items FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM public.onboarding_templates t WHERE t.id = template_id AND user_has_module_permission(auth.uid(), t.organization_id, 'hr', 'read')));

CREATE TABLE public.employee_onboarding (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  employee_id UUID NOT NULL REFERENCES public.employees(id) ON DELETE CASCADE,
  template_id UUID REFERENCES public.onboarding_templates(id),
  onboarding_type TEXT NOT NULL DEFAULT 'onboarding',
  status TEXT NOT NULL DEFAULT 'in_progress',
  started_at TIMESTAMPTZ DEFAULT now(),
  completed_at TIMESTAMPTZ,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.employee_onboarding ENABLE ROW LEVEL SECURITY;

CREATE POLICY "employee_onboarding_select" ON public.employee_onboarding FOR SELECT TO authenticated
  USING (user_has_module_permission(auth.uid(), organization_id, 'hr', 'read'));

CREATE POLICY "employee_onboarding_manage" ON public.employee_onboarding FOR ALL TO authenticated
  USING (user_has_module_permission(auth.uid(), organization_id, 'hr', 'write'));

CREATE TABLE public.employee_onboarding_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  onboarding_id UUID NOT NULL REFERENCES public.employee_onboarding(id) ON DELETE CASCADE,
  template_item_id UUID REFERENCES public.onboarding_template_items(id),
  title TEXT NOT NULL,
  description TEXT,
  category TEXT DEFAULT 'general',
  is_completed BOOLEAN DEFAULT false,
  completed_by UUID REFERENCES auth.users(id),
  completed_at TIMESTAMPTZ,
  notes TEXT,
  sort_order INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.employee_onboarding_items ENABLE ROW LEVEL SECURITY;

CREATE POLICY "employee_onboarding_items_access" ON public.employee_onboarding_items FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM public.employee_onboarding o WHERE o.id = onboarding_id AND user_has_module_permission(auth.uid(), o.organization_id, 'hr', 'read')));

-- Phase 4: Salary Structures
CREATE TABLE public.salary_structures (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  code TEXT,
  description TEXT,
  is_active BOOLEAN DEFAULT true,
  country_code TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.salary_structures ENABLE ROW LEVEL SECURITY;

CREATE POLICY "salary_structures_select" ON public.salary_structures FOR SELECT TO authenticated
  USING (user_has_module_permission(auth.uid(), organization_id, 'hr', 'read'));

CREATE POLICY "salary_structures_manage" ON public.salary_structures FOR ALL TO authenticated
  USING (user_has_module_permission(auth.uid(), organization_id, 'hr', 'write'));

CREATE TABLE public.salary_components (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  structure_id UUID NOT NULL REFERENCES public.salary_structures(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  code TEXT NOT NULL,
  component_type TEXT NOT NULL DEFAULT 'earning',
  computation_type TEXT NOT NULL DEFAULT 'fixed',
  computation_value NUMERIC DEFAULT 0,
  percentage_of TEXT,
  is_taxable BOOLEAN DEFAULT true,
  is_statutory BOOLEAN DEFAULT false,
  statutory_rule_type TEXT,
  sort_order INTEGER DEFAULT 0,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.salary_components ENABLE ROW LEVEL SECURITY;

CREATE POLICY "salary_components_access" ON public.salary_components FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM public.salary_structures s WHERE s.id = structure_id AND user_has_module_permission(auth.uid(), s.organization_id, 'hr', 'read')));

-- Phase 4: Benefits
CREATE TABLE public.benefit_plans (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  benefit_type TEXT NOT NULL DEFAULT 'health',
  description TEXT,
  provider TEXT,
  employer_contribution NUMERIC DEFAULT 0,
  employee_contribution NUMERIC DEFAULT 0,
  contribution_type TEXT DEFAULT 'fixed',
  is_active BOOLEAN DEFAULT true,
  effective_from DATE,
  effective_to DATE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.benefit_plans ENABLE ROW LEVEL SECURITY;

CREATE POLICY "benefit_plans_select" ON public.benefit_plans FOR SELECT TO authenticated
  USING (user_has_module_permission(auth.uid(), organization_id, 'hr', 'read'));

CREATE POLICY "benefit_plans_manage" ON public.benefit_plans FOR ALL TO authenticated
  USING (user_has_module_permission(auth.uid(), organization_id, 'hr', 'write'));

CREATE TABLE public.employee_benefits (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  employee_id UUID NOT NULL REFERENCES public.employees(id) ON DELETE CASCADE,
  benefit_plan_id UUID NOT NULL REFERENCES public.benefit_plans(id) ON DELETE CASCADE,
  enrollment_date DATE NOT NULL DEFAULT CURRENT_DATE,
  end_date DATE,
  status TEXT DEFAULT 'active',
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(employee_id, benefit_plan_id)
);

ALTER TABLE public.employee_benefits ENABLE ROW LEVEL SECURITY;

CREATE POLICY "employee_benefits_select" ON public.employee_benefits FOR SELECT TO authenticated
  USING (user_has_module_permission(auth.uid(), organization_id, 'hr', 'read'));

CREATE POLICY "employee_benefits_manage" ON public.employee_benefits FOR ALL TO authenticated
  USING (user_has_module_permission(auth.uid(), organization_id, 'hr', 'write'));

-- Storage bucket for employee documents
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('employee-documents', 'employee-documents', false, 10485760, 
  ARRAY['application/pdf','image/jpeg','image/png','image/webp','application/msword','application/vnd.openxmlformats-officedocument.wordprocessingml.document'])
ON CONFLICT (id) DO NOTHING;

CREATE POLICY "Authenticated users can upload employee documents" ON storage.objects
  FOR INSERT TO authenticated WITH CHECK (bucket_id = 'employee-documents');

CREATE POLICY "Authenticated users can view employee documents" ON storage.objects
  FOR SELECT TO authenticated USING (bucket_id = 'employee-documents');

CREATE POLICY "Authenticated users can delete employee documents" ON storage.objects
  FOR DELETE TO authenticated USING (bucket_id = 'employee-documents');
