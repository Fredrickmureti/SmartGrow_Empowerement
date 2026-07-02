-- Add missing tables for Phase 5 with correct RLS

-- Scheduled Report Delivery
CREATE TABLE IF NOT EXISTS public.scheduled_reports (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  template_id UUID REFERENCES public.report_templates(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  report_type TEXT NOT NULL,
  schedule_type TEXT NOT NULL,
  schedule_config JSONB DEFAULT '{}',
  recipients JSONB NOT NULL DEFAULT '[]',
  format TEXT DEFAULT 'pdf',
  include_charts BOOLEAN DEFAULT true,
  date_range_type TEXT DEFAULT 'last_month',
  filters JSONB DEFAULT '{}',
  is_active BOOLEAN DEFAULT true,
  last_sent_at TIMESTAMPTZ,
  next_send_at TIMESTAMPTZ,
  created_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Report Generation Logs
CREATE TABLE IF NOT EXISTS public.report_generation_logs (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  scheduled_report_id UUID REFERENCES public.scheduled_reports(id) ON DELETE SET NULL,
  template_id UUID REFERENCES public.report_templates(id) ON DELETE SET NULL,
  report_type TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  generated_by UUID,
  recipients_sent JSONB DEFAULT '[]',
  file_url TEXT,
  file_size_bytes INTEGER,
  parameters JSONB DEFAULT '{}',
  error_message TEXT,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Compliance Checklist Items
CREATE TABLE IF NOT EXISTS public.compliance_checklist (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  business_id UUID REFERENCES public.businesses(id) ON DELETE CASCADE,
  category TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  due_date DATE,
  frequency TEXT,
  status TEXT DEFAULT 'pending',
  assigned_to UUID,
  completed_at TIMESTAMPTZ,
  completed_by UUID,
  notes TEXT,
  attachments JSONB DEFAULT '[]',
  reminder_days INTEGER DEFAULT 7,
  last_reminded_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Enable RLS
ALTER TABLE public.scheduled_reports ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.report_generation_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.compliance_checklist ENABLE ROW LEVEL SECURITY;

-- RLS Policies using profiles table
DROP POLICY IF EXISTS "Users can manage their org scheduled reports" ON public.scheduled_reports;
DROP POLICY IF EXISTS "Users can view their org report logs" ON public.report_generation_logs;
DROP POLICY IF EXISTS "Users can manage their org compliance checklist" ON public.compliance_checklist;

CREATE POLICY "Users can manage their org scheduled reports"
  ON public.scheduled_reports FOR ALL
  USING (organization_id IN (SELECT organization_id FROM public.profiles WHERE id = auth.uid()));

CREATE POLICY "Users can view their org report logs"
  ON public.report_generation_logs FOR ALL
  USING (organization_id IN (SELECT organization_id FROM public.profiles WHERE id = auth.uid()));

CREATE POLICY "Users can manage their org compliance checklist"
  ON public.compliance_checklist FOR ALL
  USING (organization_id IN (SELECT organization_id FROM public.profiles WHERE id = auth.uid()));

-- Indexes
CREATE INDEX IF NOT EXISTS idx_scheduled_reports_org ON public.scheduled_reports(organization_id);
CREATE INDEX IF NOT EXISTS idx_scheduled_reports_next_send ON public.scheduled_reports(next_send_at) WHERE is_active = true;
CREATE INDEX IF NOT EXISTS idx_report_logs_org ON public.report_generation_logs(organization_id);
CREATE INDEX IF NOT EXISTS idx_compliance_checklist_org ON public.compliance_checklist(organization_id);
CREATE INDEX IF NOT EXISTS idx_compliance_checklist_due ON public.compliance_checklist(due_date) WHERE status != 'completed';

-- Function to update compliance status to overdue
CREATE OR REPLACE FUNCTION public.update_overdue_compliance_items()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE public.compliance_checklist
  SET 
    status = 'overdue',
    updated_at = now()
  WHERE 
    status IN ('pending', 'in_progress')
    AND due_date < CURRENT_DATE;
END;
$$;