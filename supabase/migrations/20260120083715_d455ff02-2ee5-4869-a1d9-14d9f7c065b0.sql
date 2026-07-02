-- =====================================================
-- LEAVE/TIME OFF MANAGEMENT MODULE
-- =====================================================

-- Leave Types (Organization Level)
CREATE TABLE public.leave_types (
    id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
    organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    code TEXT NOT NULL,
    color TEXT DEFAULT '#3B82F6',
    description TEXT,
    requires_approval BOOLEAN DEFAULT true,
    requires_document BOOLEAN DEFAULT false,
    is_paid BOOLEAN DEFAULT true,
    max_consecutive_days INTEGER,
    min_notice_days INTEGER DEFAULT 0,
    allow_half_day BOOLEAN DEFAULT true,
    accrual_enabled BOOLEAN DEFAULT false,
    accrual_rate NUMERIC(10,2) DEFAULT 0,
    accrual_frequency TEXT DEFAULT 'monthly' CHECK (accrual_frequency IN ('monthly', 'quarterly', 'yearly')),
    carryover_enabled BOOLEAN DEFAULT false,
    carryover_limit NUMERIC(10,2),
    carryover_deadline TEXT,
    negative_balance_allowed BOOLEAN DEFAULT false,
    negative_balance_limit NUMERIC(10,2),
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE(organization_id, code)
);

-- Leave Allocations (Employee Level)
CREATE TABLE public.leave_allocations (
    id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
    organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
    business_id UUID REFERENCES public.businesses(id) ON DELETE CASCADE,
    employee_id UUID NOT NULL REFERENCES public.employees(id) ON DELETE CASCADE,
    leave_type_id UUID NOT NULL REFERENCES public.leave_types(id) ON DELETE CASCADE,
    allocation_type TEXT NOT NULL DEFAULT 'manual' CHECK (allocation_type IN ('manual', 'accrual', 'carryover', 'adjustment')),
    year INTEGER NOT NULL,
    days_allocated NUMERIC(10,2) NOT NULL DEFAULT 0,
    days_used NUMERIC(10,2) NOT NULL DEFAULT 0,
    days_pending NUMERIC(10,2) NOT NULL DEFAULT 0,
    effective_date DATE NOT NULL DEFAULT CURRENT_DATE,
    expiry_date DATE,
    notes TEXT,
    approved_by UUID REFERENCES auth.users(id),
    approved_at TIMESTAMPTZ,
    created_by UUID REFERENCES auth.users(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Leave Requests (Employee Level)
CREATE TABLE public.leave_requests (
    id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
    organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
    business_id UUID REFERENCES public.businesses(id) ON DELETE CASCADE,
    employee_id UUID NOT NULL REFERENCES public.employees(id) ON DELETE CASCADE,
    leave_type_id UUID NOT NULL REFERENCES public.leave_types(id) ON DELETE CASCADE,
    request_number TEXT NOT NULL,
    start_date DATE NOT NULL,
    end_date DATE NOT NULL,
    start_period TEXT DEFAULT 'full' CHECK (start_period IN ('full', 'morning', 'afternoon')),
    end_period TEXT DEFAULT 'full' CHECK (end_period IN ('full', 'morning', 'afternoon')),
    days_requested NUMERIC(10,2) NOT NULL,
    reason TEXT,
    attachment_url TEXT,
    status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'pending', 'approved', 'rejected', 'cancelled')),
    submitted_at TIMESTAMPTZ,
    first_approver_id UUID REFERENCES auth.users(id),
    first_approval_at TIMESTAMPTZ,
    second_approver_id UUID REFERENCES auth.users(id),
    second_approval_at TIMESTAMPTZ,
    rejected_by UUID REFERENCES auth.users(id),
    rejected_at TIMESTAMPTZ,
    rejection_reason TEXT,
    cancelled_at TIMESTAMPTZ,
    cancellation_reason TEXT,
    created_by UUID REFERENCES auth.users(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE(organization_id, request_number)
);

-- Public Holidays (Organization Level)
CREATE TABLE public.public_holidays (
    id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
    organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    date DATE NOT NULL,
    year INTEGER NOT NULL,
    is_recurring BOOLEAN DEFAULT false,
    applies_to_all BOOLEAN DEFAULT true,
    branch_ids UUID[],
    description TEXT,
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- =====================================================
-- TIMESHEETS MODULE
-- =====================================================

-- Timesheet Settings (Organization Level)
CREATE TABLE public.timesheet_settings (
    id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
    organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE UNIQUE,
    submission_frequency TEXT DEFAULT 'weekly' CHECK (submission_frequency IN ('daily', 'weekly', 'bi_weekly', 'monthly')),
    week_start_day INTEGER DEFAULT 1 CHECK (week_start_day >= 0 AND week_start_day <= 6),
    require_project BOOLEAN DEFAULT false,
    require_task BOOLEAN DEFAULT false,
    require_approval BOOLEAN DEFAULT true,
    default_billable BOOLEAN DEFAULT false,
    minimum_hours_per_day NUMERIC(4,2) DEFAULT 0,
    maximum_hours_per_day NUMERIC(4,2) DEFAULT 24,
    overtime_threshold_daily NUMERIC(4,2) DEFAULT 8,
    overtime_threshold_weekly NUMERIC(4,2) DEFAULT 40,
    reminder_enabled BOOLEAN DEFAULT true,
    reminder_day INTEGER DEFAULT 5,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Timesheets (Individual Time Entries)
CREATE TABLE public.timesheets (
    id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
    organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
    business_id UUID REFERENCES public.businesses(id) ON DELETE CASCADE,
    employee_id UUID NOT NULL REFERENCES public.employees(id) ON DELETE CASCADE,
    project_id UUID,
    task_id UUID,
    date DATE NOT NULL,
    hours NUMERIC(6,2) NOT NULL CHECK (hours >= 0 AND hours <= 24),
    description TEXT,
    is_billable BOOLEAN DEFAULT false,
    billing_rate NUMERIC(12,2),
    billing_amount NUMERIC(12,2),
    status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'submitted', 'approved', 'rejected')),
    submitted_at TIMESTAMPTZ,
    approved_by UUID REFERENCES auth.users(id),
    approved_at TIMESTAMPTZ,
    rejected_by UUID REFERENCES auth.users(id),
    rejected_at TIMESTAMPTZ,
    rejection_reason TEXT,
    invoice_id UUID REFERENCES public.invoices(id),
    is_invoiced BOOLEAN DEFAULT false,
    created_by UUID REFERENCES auth.users(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Timesheet Submissions (Weekly/Period Submissions)
CREATE TABLE public.timesheet_submissions (
    id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
    organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
    business_id UUID REFERENCES public.businesses(id) ON DELETE CASCADE,
    employee_id UUID NOT NULL REFERENCES public.employees(id) ON DELETE CASCADE,
    period_start DATE NOT NULL,
    period_end DATE NOT NULL,
    total_hours NUMERIC(8,2) NOT NULL DEFAULT 0,
    billable_hours NUMERIC(8,2) NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'submitted', 'approved', 'rejected')),
    submitted_at TIMESTAMPTZ,
    approved_by UUID REFERENCES auth.users(id),
    approved_at TIMESTAMPTZ,
    rejected_by UUID REFERENCES auth.users(id),
    rejected_at TIMESTAMPTZ,
    rejection_reason TEXT,
    notes TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE(organization_id, employee_id, period_start, period_end)
);

-- =====================================================
-- PROJECT MANAGEMENT MODULE
-- =====================================================

-- Projects (Business Level)
CREATE TABLE public.projects (
    id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
    organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
    business_id UUID REFERENCES public.businesses(id) ON DELETE CASCADE,
    branch_id UUID REFERENCES public.branches(id) ON DELETE SET NULL,
    project_number TEXT NOT NULL,
    name TEXT NOT NULL,
    description TEXT,
    project_type TEXT DEFAULT 'internal' CHECK (project_type IN ('internal', 'client', 'template')),
    customer_id UUID REFERENCES public.contacts(id) ON DELETE SET NULL,
    status TEXT DEFAULT 'draft' CHECK (status IN ('draft', 'active', 'on_hold', 'completed', 'cancelled')),
    priority INTEGER DEFAULT 1 CHECK (priority >= 0 AND priority <= 3),
    start_date DATE,
    end_date DATE,
    actual_start_date DATE,
    actual_end_date DATE,
    budget NUMERIC(14,2),
    budget_type TEXT DEFAULT 'none' CHECK (budget_type IN ('fixed', 'hourly', 'none')),
    hourly_rate NUMERIC(12,2),
    allocated_hours NUMERIC(10,2),
    spent_hours NUMERIC(10,2) DEFAULT 0,
    color TEXT DEFAULT '#3B82F6',
    manager_id UUID REFERENCES auth.users(id),
    is_billable BOOLEAN DEFAULT false,
    allow_timesheets BOOLEAN DEFAULT true,
    privacy TEXT DEFAULT 'team' CHECK (privacy IN ('public', 'team', 'private')),
    tags TEXT[],
    is_active BOOLEAN DEFAULT true,
    created_by UUID REFERENCES auth.users(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE(organization_id, project_number)
);

-- Project Stages (Project-specific Kanban columns)
CREATE TABLE public.project_stages (
    id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
    project_id UUID NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    sequence INTEGER NOT NULL DEFAULT 0,
    is_closed BOOLEAN DEFAULT false,
    fold BOOLEAN DEFAULT false,
    color TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Project Milestones
CREATE TABLE public.project_milestones (
    id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
    project_id UUID NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    description TEXT,
    deadline DATE,
    is_reached BOOLEAN DEFAULT false,
    reached_at TIMESTAMPTZ,
    sequence INTEGER DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Project Tasks
CREATE TABLE public.project_tasks (
    id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
    organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
    project_id UUID NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
    stage_id UUID REFERENCES public.project_stages(id) ON DELETE SET NULL,
    parent_task_id UUID REFERENCES public.project_tasks(id) ON DELETE CASCADE,
    milestone_id UUID REFERENCES public.project_milestones(id) ON DELETE SET NULL,
    task_number TEXT NOT NULL,
    name TEXT NOT NULL,
    description TEXT,
    assigned_to UUID REFERENCES auth.users(id),
    assignees UUID[],
    priority INTEGER DEFAULT 1 CHECK (priority >= 0 AND priority <= 3),
    tags TEXT[],
    start_date DATE,
    deadline DATE,
    planned_hours NUMERIC(8,2),
    effective_hours NUMERIC(8,2) DEFAULT 0,
    remaining_hours NUMERIC(8,2),
    progress INTEGER DEFAULT 0 CHECK (progress >= 0 AND progress <= 100),
    is_recurring BOOLEAN DEFAULT false,
    recurrence_rule JSONB,
    depends_on UUID[],
    is_blocked BOOLEAN DEFAULT false,
    blocked_reason TEXT,
    is_done BOOLEAN DEFAULT false,
    completed_at TIMESTAMPTZ,
    completed_by UUID REFERENCES auth.users(id),
    is_active BOOLEAN DEFAULT true,
    created_by UUID REFERENCES auth.users(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Project Task Activities (Comments, status changes, etc.)
CREATE TABLE public.project_task_activities (
    id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
    task_id UUID NOT NULL REFERENCES public.project_tasks(id) ON DELETE CASCADE,
    activity_type TEXT NOT NULL CHECK (activity_type IN ('comment', 'status_change', 'assignment', 'attachment', 'time_logged')),
    content TEXT,
    metadata JSONB,
    created_by UUID REFERENCES auth.users(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- =====================================================
-- CRM MODULE
-- =====================================================

-- CRM Stages (Organization Level - Sales Pipeline)
CREATE TABLE public.crm_stages (
    id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
    organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    sequence INTEGER NOT NULL DEFAULT 0,
    is_won BOOLEAN DEFAULT false,
    is_lost BOOLEAN DEFAULT false,
    probability INTEGER DEFAULT 0 CHECK (probability >= 0 AND probability <= 100),
    fold BOOLEAN DEFAULT false,
    requirements TEXT,
    color TEXT DEFAULT '#3B82F6',
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- CRM Lost Reasons
CREATE TABLE public.crm_lost_reasons (
    id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
    organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- CRM Activity Types
CREATE TABLE public.crm_activity_types (
    id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
    organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    icon TEXT DEFAULT 'phone',
    color TEXT DEFAULT '#3B82F6',
    default_duration INTEGER DEFAULT 30,
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- CRM Leads/Opportunities
CREATE TABLE public.crm_leads (
    id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
    organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
    business_id UUID REFERENCES public.businesses(id) ON DELETE CASCADE,
    lead_number TEXT NOT NULL,
    name TEXT NOT NULL,
    type TEXT DEFAULT 'lead' CHECK (type IN ('lead', 'opportunity')),
    stage_id UUID REFERENCES public.crm_stages(id) ON DELETE SET NULL,
    contact_id UUID REFERENCES public.contacts(id) ON DELETE SET NULL,
    contact_name TEXT,
    email TEXT,
    phone TEXT,
    company_name TEXT,
    website TEXT,
    street TEXT,
    city TEXT,
    state TEXT,
    country TEXT,
    expected_revenue NUMERIC(14,2),
    probability INTEGER DEFAULT 0 CHECK (probability >= 0 AND probability <= 100),
    expected_close_date DATE,
    source TEXT,
    medium TEXT,
    campaign TEXT,
    assigned_to UUID REFERENCES auth.users(id),
    team_id UUID,
    priority INTEGER DEFAULT 1 CHECK (priority >= 0 AND priority <= 3),
    tags TEXT[],
    description TEXT,
    internal_notes TEXT,
    lost_reason_id UUID REFERENCES public.crm_lost_reasons(id),
    lost_notes TEXT,
    won_at TIMESTAMPTZ,
    lost_at TIMESTAMPTZ,
    converted_at TIMESTAMPTZ,
    converted_to_contact_id UUID REFERENCES public.contacts(id),
    next_activity_date DATE,
    next_activity_summary TEXT,
    is_active BOOLEAN DEFAULT true,
    created_by UUID REFERENCES auth.users(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE(organization_id, lead_number)
);

-- CRM Activities
CREATE TABLE public.crm_activities (
    id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
    organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
    lead_id UUID NOT NULL REFERENCES public.crm_leads(id) ON DELETE CASCADE,
    activity_type_id UUID REFERENCES public.crm_activity_types(id) ON DELETE SET NULL,
    activity_type TEXT DEFAULT 'task' CHECK (activity_type IN ('call', 'email', 'meeting', 'task', 'note', 'deadline')),
    summary TEXT NOT NULL,
    description TEXT,
    due_date DATE,
    due_time TIME,
    duration INTEGER,
    assigned_to UUID REFERENCES auth.users(id),
    is_done BOOLEAN DEFAULT false,
    completed_at TIMESTAMPTZ,
    completed_by UUID REFERENCES auth.users(id),
    outcome TEXT,
    created_by UUID REFERENCES auth.users(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- =====================================================
-- INDEXES
-- =====================================================

-- Leave indexes
CREATE INDEX idx_leave_types_org ON public.leave_types(organization_id);
CREATE INDEX idx_leave_allocations_employee ON public.leave_allocations(employee_id, year);
CREATE INDEX idx_leave_allocations_type ON public.leave_allocations(leave_type_id);
CREATE INDEX idx_leave_requests_employee ON public.leave_requests(employee_id);
CREATE INDEX idx_leave_requests_status ON public.leave_requests(status);
CREATE INDEX idx_leave_requests_dates ON public.leave_requests(start_date, end_date);
CREATE INDEX idx_public_holidays_org_year ON public.public_holidays(organization_id, year);

-- Timesheet indexes
CREATE INDEX idx_timesheets_employee ON public.timesheets(employee_id);
CREATE INDEX idx_timesheets_date ON public.timesheets(date);
CREATE INDEX idx_timesheets_project ON public.timesheets(project_id);
CREATE INDEX idx_timesheets_status ON public.timesheets(status);
CREATE INDEX idx_timesheet_submissions_employee ON public.timesheet_submissions(employee_id);

-- Project indexes
CREATE INDEX idx_projects_org ON public.projects(organization_id);
CREATE INDEX idx_projects_business ON public.projects(business_id);
CREATE INDEX idx_projects_status ON public.projects(status);
CREATE INDEX idx_project_tasks_project ON public.project_tasks(project_id);
CREATE INDEX idx_project_tasks_assigned ON public.project_tasks(assigned_to);
CREATE INDEX idx_project_tasks_stage ON public.project_tasks(stage_id);

-- CRM indexes
CREATE INDEX idx_crm_leads_org ON public.crm_leads(organization_id);
CREATE INDEX idx_crm_leads_business ON public.crm_leads(business_id);
CREATE INDEX idx_crm_leads_stage ON public.crm_leads(stage_id);
CREATE INDEX idx_crm_leads_assigned ON public.crm_leads(assigned_to);
CREATE INDEX idx_crm_leads_type ON public.crm_leads(type);
CREATE INDEX idx_crm_activities_lead ON public.crm_activities(lead_id);
CREATE INDEX idx_crm_activities_due ON public.crm_activities(due_date);

-- =====================================================
-- ROW LEVEL SECURITY
-- =====================================================

-- Enable RLS on all tables
ALTER TABLE public.leave_types ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.leave_allocations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.leave_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.public_holidays ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.timesheet_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.timesheets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.timesheet_submissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.projects ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.project_stages ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.project_milestones ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.project_tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.project_task_activities ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.crm_stages ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.crm_lost_reasons ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.crm_activity_types ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.crm_leads ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.crm_activities ENABLE ROW LEVEL SECURITY;

-- Leave Types Policies
CREATE POLICY "Users can view leave types in their organization"
ON public.leave_types FOR SELECT
USING (organization_id IN (
    SELECT organization_id FROM public.user_roles WHERE user_id = auth.uid()
));

CREATE POLICY "Users can manage leave types in their organization"
ON public.leave_types FOR ALL
USING (organization_id IN (
    SELECT organization_id FROM public.user_roles WHERE user_id = auth.uid()
));

-- Leave Allocations Policies
CREATE POLICY "Users can view leave allocations in their organization"
ON public.leave_allocations FOR SELECT
USING (organization_id IN (
    SELECT organization_id FROM public.user_roles WHERE user_id = auth.uid()
));

CREATE POLICY "Users can manage leave allocations in their organization"
ON public.leave_allocations FOR ALL
USING (organization_id IN (
    SELECT organization_id FROM public.user_roles WHERE user_id = auth.uid()
));

-- Leave Requests Policies
CREATE POLICY "Users can view leave requests in their organization"
ON public.leave_requests FOR SELECT
USING (organization_id IN (
    SELECT organization_id FROM public.user_roles WHERE user_id = auth.uid()
));

CREATE POLICY "Users can manage leave requests in their organization"
ON public.leave_requests FOR ALL
USING (organization_id IN (
    SELECT organization_id FROM public.user_roles WHERE user_id = auth.uid()
));

-- Public Holidays Policies
CREATE POLICY "Users can view public holidays in their organization"
ON public.public_holidays FOR SELECT
USING (organization_id IN (
    SELECT organization_id FROM public.user_roles WHERE user_id = auth.uid()
));

CREATE POLICY "Users can manage public holidays in their organization"
ON public.public_holidays FOR ALL
USING (organization_id IN (
    SELECT organization_id FROM public.user_roles WHERE user_id = auth.uid()
));

-- Timesheet Settings Policies
CREATE POLICY "Users can view timesheet settings in their organization"
ON public.timesheet_settings FOR SELECT
USING (organization_id IN (
    SELECT organization_id FROM public.user_roles WHERE user_id = auth.uid()
));

CREATE POLICY "Users can manage timesheet settings in their organization"
ON public.timesheet_settings FOR ALL
USING (organization_id IN (
    SELECT organization_id FROM public.user_roles WHERE user_id = auth.uid()
));

-- Timesheets Policies
CREATE POLICY "Users can view timesheets in their organization"
ON public.timesheets FOR SELECT
USING (organization_id IN (
    SELECT organization_id FROM public.user_roles WHERE user_id = auth.uid()
));

CREATE POLICY "Users can manage timesheets in their organization"
ON public.timesheets FOR ALL
USING (organization_id IN (
    SELECT organization_id FROM public.user_roles WHERE user_id = auth.uid()
));

-- Timesheet Submissions Policies
CREATE POLICY "Users can view timesheet submissions in their organization"
ON public.timesheet_submissions FOR SELECT
USING (organization_id IN (
    SELECT organization_id FROM public.user_roles WHERE user_id = auth.uid()
));

CREATE POLICY "Users can manage timesheet submissions in their organization"
ON public.timesheet_submissions FOR ALL
USING (organization_id IN (
    SELECT organization_id FROM public.user_roles WHERE user_id = auth.uid()
));

-- Projects Policies
CREATE POLICY "Users can view projects in their organization"
ON public.projects FOR SELECT
USING (organization_id IN (
    SELECT organization_id FROM public.user_roles WHERE user_id = auth.uid()
));

CREATE POLICY "Users can manage projects in their organization"
ON public.projects FOR ALL
USING (organization_id IN (
    SELECT organization_id FROM public.user_roles WHERE user_id = auth.uid()
));

-- Project Stages Policies
CREATE POLICY "Users can view project stages"
ON public.project_stages FOR SELECT
USING (project_id IN (
    SELECT id FROM public.projects WHERE organization_id IN (
        SELECT organization_id FROM public.user_roles WHERE user_id = auth.uid()
    )
));

CREATE POLICY "Users can manage project stages"
ON public.project_stages FOR ALL
USING (project_id IN (
    SELECT id FROM public.projects WHERE organization_id IN (
        SELECT organization_id FROM public.user_roles WHERE user_id = auth.uid()
    )
));

-- Project Milestones Policies
CREATE POLICY "Users can view project milestones"
ON public.project_milestones FOR SELECT
USING (project_id IN (
    SELECT id FROM public.projects WHERE organization_id IN (
        SELECT organization_id FROM public.user_roles WHERE user_id = auth.uid()
    )
));

CREATE POLICY "Users can manage project milestones"
ON public.project_milestones FOR ALL
USING (project_id IN (
    SELECT id FROM public.projects WHERE organization_id IN (
        SELECT organization_id FROM public.user_roles WHERE user_id = auth.uid()
    )
));

-- Project Tasks Policies
CREATE POLICY "Users can view project tasks in their organization"
ON public.project_tasks FOR SELECT
USING (organization_id IN (
    SELECT organization_id FROM public.user_roles WHERE user_id = auth.uid()
));

CREATE POLICY "Users can manage project tasks in their organization"
ON public.project_tasks FOR ALL
USING (organization_id IN (
    SELECT organization_id FROM public.user_roles WHERE user_id = auth.uid()
));

-- Project Task Activities Policies
CREATE POLICY "Users can view project task activities"
ON public.project_task_activities FOR SELECT
USING (task_id IN (
    SELECT id FROM public.project_tasks WHERE organization_id IN (
        SELECT organization_id FROM public.user_roles WHERE user_id = auth.uid()
    )
));

CREATE POLICY "Users can manage project task activities"
ON public.project_task_activities FOR ALL
USING (task_id IN (
    SELECT id FROM public.project_tasks WHERE organization_id IN (
        SELECT organization_id FROM public.user_roles WHERE user_id = auth.uid()
    )
));

-- CRM Stages Policies
CREATE POLICY "Users can view CRM stages in their organization"
ON public.crm_stages FOR SELECT
USING (organization_id IN (
    SELECT organization_id FROM public.user_roles WHERE user_id = auth.uid()
));

CREATE POLICY "Users can manage CRM stages in their organization"
ON public.crm_stages FOR ALL
USING (organization_id IN (
    SELECT organization_id FROM public.user_roles WHERE user_id = auth.uid()
));

-- CRM Lost Reasons Policies
CREATE POLICY "Users can view CRM lost reasons in their organization"
ON public.crm_lost_reasons FOR SELECT
USING (organization_id IN (
    SELECT organization_id FROM public.user_roles WHERE user_id = auth.uid()
));

CREATE POLICY "Users can manage CRM lost reasons in their organization"
ON public.crm_lost_reasons FOR ALL
USING (organization_id IN (
    SELECT organization_id FROM public.user_roles WHERE user_id = auth.uid()
));

-- CRM Activity Types Policies
CREATE POLICY "Users can view CRM activity types in their organization"
ON public.crm_activity_types FOR SELECT
USING (organization_id IN (
    SELECT organization_id FROM public.user_roles WHERE user_id = auth.uid()
));

CREATE POLICY "Users can manage CRM activity types in their organization"
ON public.crm_activity_types FOR ALL
USING (organization_id IN (
    SELECT organization_id FROM public.user_roles WHERE user_id = auth.uid()
));

-- CRM Leads Policies
CREATE POLICY "Users can view CRM leads in their organization"
ON public.crm_leads FOR SELECT
USING (organization_id IN (
    SELECT organization_id FROM public.user_roles WHERE user_id = auth.uid()
));

CREATE POLICY "Users can manage CRM leads in their organization"
ON public.crm_leads FOR ALL
USING (organization_id IN (
    SELECT organization_id FROM public.user_roles WHERE user_id = auth.uid()
));

-- CRM Activities Policies
CREATE POLICY "Users can view CRM activities in their organization"
ON public.crm_activities FOR SELECT
USING (organization_id IN (
    SELECT organization_id FROM public.user_roles WHERE user_id = auth.uid()
));

CREATE POLICY "Users can manage CRM activities in their organization"
ON public.crm_activities FOR ALL
USING (organization_id IN (
    SELECT organization_id FROM public.user_roles WHERE user_id = auth.uid()
));

-- =====================================================
-- TRIGGERS FOR UPDATED_AT
-- =====================================================

CREATE TRIGGER update_leave_types_updated_at
    BEFORE UPDATE ON public.leave_types
    FOR EACH ROW
    EXECUTE FUNCTION public.update_updated_at_column();

CREATE TRIGGER update_leave_allocations_updated_at
    BEFORE UPDATE ON public.leave_allocations
    FOR EACH ROW
    EXECUTE FUNCTION public.update_updated_at_column();

CREATE TRIGGER update_leave_requests_updated_at
    BEFORE UPDATE ON public.leave_requests
    FOR EACH ROW
    EXECUTE FUNCTION public.update_updated_at_column();

CREATE TRIGGER update_public_holidays_updated_at
    BEFORE UPDATE ON public.public_holidays
    FOR EACH ROW
    EXECUTE FUNCTION public.update_updated_at_column();

CREATE TRIGGER update_timesheet_settings_updated_at
    BEFORE UPDATE ON public.timesheet_settings
    FOR EACH ROW
    EXECUTE FUNCTION public.update_updated_at_column();

CREATE TRIGGER update_timesheets_updated_at
    BEFORE UPDATE ON public.timesheets
    FOR EACH ROW
    EXECUTE FUNCTION public.update_updated_at_column();

CREATE TRIGGER update_timesheet_submissions_updated_at
    BEFORE UPDATE ON public.timesheet_submissions
    FOR EACH ROW
    EXECUTE FUNCTION public.update_updated_at_column();

CREATE TRIGGER update_projects_updated_at
    BEFORE UPDATE ON public.projects
    FOR EACH ROW
    EXECUTE FUNCTION public.update_updated_at_column();

CREATE TRIGGER update_project_stages_updated_at
    BEFORE UPDATE ON public.project_stages
    FOR EACH ROW
    EXECUTE FUNCTION public.update_updated_at_column();

CREATE TRIGGER update_project_milestones_updated_at
    BEFORE UPDATE ON public.project_milestones
    FOR EACH ROW
    EXECUTE FUNCTION public.update_updated_at_column();

CREATE TRIGGER update_project_tasks_updated_at
    BEFORE UPDATE ON public.project_tasks
    FOR EACH ROW
    EXECUTE FUNCTION public.update_updated_at_column();

CREATE TRIGGER update_crm_stages_updated_at
    BEFORE UPDATE ON public.crm_stages
    FOR EACH ROW
    EXECUTE FUNCTION public.update_updated_at_column();

CREATE TRIGGER update_crm_leads_updated_at
    BEFORE UPDATE ON public.crm_leads
    FOR EACH ROW
    EXECUTE FUNCTION public.update_updated_at_column();

CREATE TRIGGER update_crm_activities_updated_at
    BEFORE UPDATE ON public.crm_activities
    FOR EACH ROW
    EXECUTE FUNCTION public.update_updated_at_column();

-- =====================================================
-- DATABASE FUNCTIONS
-- =====================================================

-- Generate next leave request number
CREATE OR REPLACE FUNCTION public.get_next_leave_request_number(p_org_id UUID)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_year TEXT;
    v_count INTEGER;
    v_number TEXT;
BEGIN
    v_year := to_char(CURRENT_DATE, 'YYYY');
    
    SELECT COUNT(*) + 1 INTO v_count
    FROM leave_requests
    WHERE organization_id = p_org_id
    AND request_number LIKE 'LR-' || v_year || '-%';
    
    v_number := 'LR-' || v_year || '-' || lpad(v_count::TEXT, 4, '0');
    
    RETURN v_number;
END;
$$;

-- Generate next project number
CREATE OR REPLACE FUNCTION public.get_next_project_number(p_org_id UUID)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_year TEXT;
    v_count INTEGER;
    v_number TEXT;
BEGIN
    v_year := to_char(CURRENT_DATE, 'YYYY');
    
    SELECT COUNT(*) + 1 INTO v_count
    FROM projects
    WHERE organization_id = p_org_id
    AND project_number LIKE 'PROJ-' || v_year || '-%';
    
    v_number := 'PROJ-' || v_year || '-' || lpad(v_count::TEXT, 4, '0');
    
    RETURN v_number;
END;
$$;

-- Generate next task number within a project
CREATE OR REPLACE FUNCTION public.get_next_task_number(p_project_id UUID)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_count INTEGER;
    v_number TEXT;
BEGIN
    SELECT COUNT(*) + 1 INTO v_count
    FROM project_tasks
    WHERE project_id = p_project_id;
    
    v_number := 'TSK-' || lpad(v_count::TEXT, 4, '0');
    
    RETURN v_number;
END;
$$;

-- Generate next lead number
CREATE OR REPLACE FUNCTION public.get_next_lead_number(p_org_id UUID)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_year TEXT;
    v_count INTEGER;
    v_number TEXT;
BEGIN
    v_year := to_char(CURRENT_DATE, 'YYYY');
    
    SELECT COUNT(*) + 1 INTO v_count
    FROM crm_leads
    WHERE organization_id = p_org_id
    AND lead_number LIKE 'LEAD-' || v_year || '-%';
    
    v_number := 'LEAD-' || v_year || '-' || lpad(v_count::TEXT, 4, '0');
    
    RETURN v_number;
END;
$$;

-- Calculate leave days between dates (excluding weekends and holidays)
CREATE OR REPLACE FUNCTION public.calculate_leave_days(
    p_start_date DATE,
    p_end_date DATE,
    p_start_period TEXT,
    p_end_period TEXT,
    p_org_id UUID
)
RETURNS NUMERIC
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_days NUMERIC := 0;
    v_current DATE;
    v_holiday_count INTEGER;
BEGIN
    v_current := p_start_date;
    
    WHILE v_current <= p_end_date LOOP
        -- Skip weekends (0 = Sunday, 6 = Saturday)
        IF EXTRACT(DOW FROM v_current) NOT IN (0, 6) THEN
            -- Check if it's a public holiday
            SELECT COUNT(*) INTO v_holiday_count
            FROM public_holidays
            WHERE organization_id = p_org_id
            AND date = v_current
            AND is_active = true;
            
            IF v_holiday_count = 0 THEN
                IF v_current = p_start_date AND p_start_period != 'full' THEN
                    v_days := v_days + 0.5;
                ELSIF v_current = p_end_date AND p_end_period != 'full' THEN
                    v_days := v_days + 0.5;
                ELSE
                    v_days := v_days + 1;
                END IF;
            END IF;
        END IF;
        
        v_current := v_current + INTERVAL '1 day';
    END LOOP;
    
    RETURN v_days;
END;
$$;

-- Get employee leave balance for a specific leave type
CREATE OR REPLACE FUNCTION public.get_leave_balance(
    p_employee_id UUID,
    p_leave_type_id UUID,
    p_year INTEGER DEFAULT EXTRACT(YEAR FROM CURRENT_DATE)::INTEGER
)
RETURNS NUMERIC
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_allocated NUMERIC := 0;
    v_used NUMERIC := 0;
    v_pending NUMERIC := 0;
BEGIN
    -- Get total allocated days
    SELECT COALESCE(SUM(days_allocated), 0) INTO v_allocated
    FROM leave_allocations
    WHERE employee_id = p_employee_id
    AND leave_type_id = p_leave_type_id
    AND year = p_year
    AND (expiry_date IS NULL OR expiry_date >= CURRENT_DATE);
    
    -- Get approved leave days
    SELECT COALESCE(SUM(days_requested), 0) INTO v_used
    FROM leave_requests
    WHERE employee_id = p_employee_id
    AND leave_type_id = p_leave_type_id
    AND status = 'approved'
    AND EXTRACT(YEAR FROM start_date) = p_year;
    
    RETURN v_allocated - v_used;
END;
$$;

-- Check for leave overlap
CREATE OR REPLACE FUNCTION public.check_leave_overlap(
    p_employee_id UUID,
    p_start_date DATE,
    p_end_date DATE,
    p_exclude_id UUID DEFAULT NULL
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_count INTEGER;
BEGIN
    SELECT COUNT(*) INTO v_count
    FROM leave_requests
    WHERE employee_id = p_employee_id
    AND status IN ('pending', 'approved')
    AND (id != p_exclude_id OR p_exclude_id IS NULL)
    AND (
        (start_date <= p_end_date AND end_date >= p_start_date)
    );
    
    RETURN v_count > 0;
END;
$$;

-- Calculate project progress based on tasks
CREATE OR REPLACE FUNCTION public.calculate_project_progress(p_project_id UUID)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_total_tasks INTEGER;
    v_completed_tasks INTEGER;
BEGIN
    SELECT COUNT(*), COUNT(*) FILTER (WHERE is_done = true)
    INTO v_total_tasks, v_completed_tasks
    FROM project_tasks
    WHERE project_id = p_project_id
    AND parent_task_id IS NULL
    AND is_active = true;
    
    IF v_total_tasks = 0 THEN
        RETURN 0;
    END IF;
    
    RETURN ROUND((v_completed_tasks::NUMERIC / v_total_tasks::NUMERIC) * 100);
END;
$$;

-- Get employee hours in a period
CREATE OR REPLACE FUNCTION public.get_employee_hours_in_period(
    p_employee_id UUID,
    p_start_date DATE,
    p_end_date DATE
)
RETURNS NUMERIC
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_hours NUMERIC;
BEGIN
    SELECT COALESCE(SUM(hours), 0) INTO v_hours
    FROM timesheets
    WHERE employee_id = p_employee_id
    AND date BETWEEN p_start_date AND p_end_date
    AND status IN ('approved', 'submitted');
    
    RETURN v_hours;
END;
$$;

-- Calculate pipeline value
CREATE OR REPLACE FUNCTION public.calculate_pipeline_value(
    p_org_id UUID,
    p_business_id UUID DEFAULT NULL
)
RETURNS NUMERIC
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_value NUMERIC;
BEGIN
    SELECT COALESCE(SUM(expected_revenue * probability / 100), 0) INTO v_value
    FROM crm_leads
    WHERE organization_id = p_org_id
    AND (p_business_id IS NULL OR business_id = p_business_id)
    AND type = 'opportunity'
    AND is_active = true
    AND won_at IS NULL
    AND lost_at IS NULL;
    
    RETURN v_value;
END;
$$;

-- Add FK for timesheets to projects
ALTER TABLE public.timesheets ADD CONSTRAINT timesheets_project_id_fkey 
    FOREIGN KEY (project_id) REFERENCES public.projects(id) ON DELETE SET NULL;

ALTER TABLE public.timesheets ADD CONSTRAINT timesheets_task_id_fkey 
    FOREIGN KEY (task_id) REFERENCES public.project_tasks(id) ON DELETE SET NULL;