-- ============================================
-- PHASE 1: Universal Custom Fields System
-- Allows custom fields on ANY entity type
-- ============================================

-- Entity Field Configurations (defines available custom fields per entity type)
CREATE TABLE public.entity_field_configs (
    id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
    organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
    business_id UUID REFERENCES public.businesses(id) ON DELETE CASCADE,
    
    -- Entity targeting
    entity_type VARCHAR(100) NOT NULL, -- invoice, contact, product, sales_order, etc.
    
    -- Field definition
    field_key VARCHAR(100) NOT NULL,
    field_label VARCHAR(255) NOT NULL,
    field_type VARCHAR(50) NOT NULL DEFAULT 'text', -- text, number, date, datetime, boolean, select, multiselect, related, computed, html, file
    
    -- Field behavior
    is_required BOOLEAN DEFAULT false,
    is_visible BOOLEAN DEFAULT true,
    is_searchable BOOLEAN DEFAULT false,
    is_filterable BOOLEAN DEFAULT false,
    display_order INTEGER DEFAULT 0,
    
    -- Field options (for select/multiselect)
    options JSONB DEFAULT '[]'::jsonb, -- [{value: "opt1", label: "Option 1", color: "#fff"}]
    
    -- Default value
    default_value TEXT,
    
    -- Validation
    validation_rules JSONB DEFAULT '{}'::jsonb, -- {min: 0, max: 100, regex: "...", message: "..."}
    
    -- Related field settings (for field_type = 'related')
    related_model VARCHAR(100), -- contacts, products, etc.
    related_display_field VARCHAR(100), -- name, email, etc.
    related_filter JSONB, -- filter conditions for related records
    
    -- Computed field settings (for field_type = 'computed')
    computation_formula TEXT, -- e.g., "{unit_price} * {quantity}"
    computation_dependencies TEXT[], -- fields this depends on
    
    -- Conditional visibility
    conditional_visibility JSONB, -- {field: "status", operator: "=", value: "active"}
    
    -- UI hints
    placeholder TEXT,
    help_text TEXT,
    field_group VARCHAR(100), -- for grouping fields in UI
    
    -- Metadata
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
    created_by UUID REFERENCES auth.users(id),
    
    -- Ensure unique field key per entity type per organization
    CONSTRAINT entity_field_configs_unique_key UNIQUE (organization_id, entity_type, field_key)
);

-- Entity Field Values (stores actual custom field values)
CREATE TABLE public.entity_field_values (
    id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
    organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
    
    -- Entity reference
    entity_type VARCHAR(100) NOT NULL,
    entity_id UUID NOT NULL,
    
    -- Field reference
    field_config_id UUID NOT NULL REFERENCES public.entity_field_configs(id) ON DELETE CASCADE,
    field_key VARCHAR(100) NOT NULL,
    
    -- Value storage (all stored as text, cast based on field_type)
    field_value TEXT,
    field_value_json JSONB, -- for complex types like multiselect, files
    
    -- Metadata
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
    updated_by UUID REFERENCES auth.users(id),
    
    -- Ensure one value per field per entity
    CONSTRAINT entity_field_values_unique UNIQUE (organization_id, entity_type, entity_id, field_key)
);

-- Indexes for performance
CREATE INDEX idx_entity_field_configs_org_entity ON public.entity_field_configs(organization_id, entity_type);
CREATE INDEX idx_entity_field_configs_searchable ON public.entity_field_configs(organization_id, entity_type) WHERE is_searchable = true;
CREATE INDEX idx_entity_field_values_entity ON public.entity_field_values(organization_id, entity_type, entity_id);
CREATE INDEX idx_entity_field_values_field ON public.entity_field_values(field_config_id);
CREATE INDEX idx_entity_field_values_search ON public.entity_field_values(organization_id, entity_type, field_key, field_value) WHERE field_value IS NOT NULL;

-- Enable RLS
ALTER TABLE public.entity_field_configs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.entity_field_values ENABLE ROW LEVEL SECURITY;

-- RLS Policies for entity_field_configs
CREATE POLICY "Users can view entity field configs in their organization"
ON public.entity_field_configs FOR SELECT
USING (
    organization_id IN (SELECT organization_id FROM public.user_roles WHERE user_id = auth.uid() AND is_active = true)
);

CREATE POLICY "Admins can manage entity field configs"
ON public.entity_field_configs FOR ALL
USING (
    organization_id IN (
        SELECT organization_id FROM public.user_roles 
        WHERE user_id = auth.uid() 
        AND role IN ('owner', 'admin', 'super_admin') 
        AND is_active = true
    )
);

-- RLS Policies for entity_field_values
CREATE POLICY "Users can view entity field values in their organization"
ON public.entity_field_values FOR SELECT
USING (
    organization_id IN (SELECT organization_id FROM public.user_roles WHERE user_id = auth.uid() AND is_active = true)
);

CREATE POLICY "Users can manage entity field values in their organization"
ON public.entity_field_values FOR ALL
USING (
    organization_id IN (SELECT organization_id FROM public.user_roles WHERE user_id = auth.uid() AND is_active = true)
);

-- Trigger for updated_at
CREATE TRIGGER update_entity_field_configs_updated_at
    BEFORE UPDATE ON public.entity_field_configs
    FOR EACH ROW
    EXECUTE FUNCTION public.update_updated_at_column();

CREATE TRIGGER update_entity_field_values_updated_at
    BEFORE UPDATE ON public.entity_field_values
    FOR EACH ROW
    EXECUTE FUNCTION public.update_updated_at_column();

-- ============================================
-- PHASE 2: Automation Engine Foundation
-- ============================================

-- Automated Actions (defines automation rules)
CREATE TABLE public.automated_actions (
    id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
    organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
    business_id UUID REFERENCES public.businesses(id) ON DELETE CASCADE,
    
    -- Basic info
    name VARCHAR(255) NOT NULL,
    description TEXT,
    is_active BOOLEAN DEFAULT true,
    
    -- Trigger configuration
    trigger_type VARCHAR(50) NOT NULL, -- on_create, on_update, on_delete, time_based, field_change, webhook, manual
    target_model VARCHAR(100) NOT NULL, -- invoice, contact, sales_order, etc.
    
    -- Trigger conditions (when to fire)
    trigger_conditions JSONB DEFAULT '[]'::jsonb, -- [{field: "status", operator: "=", value: "overdue"}]
    
    -- Filter domain (which records to apply to)
    filter_domain JSONB DEFAULT '[]'::jsonb, -- [{field: "type", operator: "=", value: "customer"}]
    
    -- For field_change trigger
    watched_fields TEXT[], -- fields that trigger this automation
    
    -- For time_based trigger
    schedule_type VARCHAR(50), -- interval, cron, specific_time
    schedule_config JSONB, -- {interval_minutes: 60} or {cron: "0 9 * * *"} or {time: "09:00", days: ["mon", "tue"]}
    next_run_at TIMESTAMP WITH TIME ZONE,
    last_run_at TIMESTAMP WITH TIME ZONE,
    
    -- Execution settings
    run_as_user_id UUID REFERENCES auth.users(id), -- execute with this user's permissions
    max_retries INTEGER DEFAULT 3,
    retry_delay_seconds INTEGER DEFAULT 60,
    
    -- Metadata
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
    created_by UUID REFERENCES auth.users(id)
);

-- Automated Action Steps (what to do when triggered)
CREATE TABLE public.automated_action_steps (
    id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
    action_id UUID NOT NULL REFERENCES public.automated_actions(id) ON DELETE CASCADE,
    
    -- Step order
    step_order INTEGER NOT NULL DEFAULT 0,
    
    -- Step configuration
    step_name VARCHAR(255),
    action_type VARCHAR(50) NOT NULL, -- update_record, create_record, send_email, send_notification, webhook_call, create_activity, add_tag, run_code
    
    -- Action configuration (varies by action_type)
    action_config JSONB NOT NULL DEFAULT '{}'::jsonb,
    -- For update_record: {fields: [{field: "status", value: "sent"}]}
    -- For send_email: {template_id: "...", to: "{customer_email}", subject: "...", body: "..."}
    -- For webhook_call: {url: "...", method: "POST", headers: {}, body: {}}
    -- For create_activity: {type: "follow_up", summary: "...", due_in_days: 7}
    -- For create_record: {model: "invoices", fields: {...}}
    
    -- Conditional execution
    condition JSONB, -- only execute if condition is met
    
    -- Error handling
    on_error VARCHAR(50) DEFAULT 'continue', -- continue, stop, retry
    
    -- Metadata
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Automation Execution Logs
CREATE TABLE public.automated_action_logs (
    id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
    organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
    action_id UUID NOT NULL REFERENCES public.automated_actions(id) ON DELETE CASCADE,
    
    -- Execution context
    trigger_type VARCHAR(50) NOT NULL,
    target_model VARCHAR(100) NOT NULL,
    target_record_id UUID,
    
    -- Execution result
    status VARCHAR(50) NOT NULL, -- pending, running, completed, failed, skipped
    started_at TIMESTAMP WITH TIME ZONE,
    completed_at TIMESTAMP WITH TIME ZONE,
    
    -- Step execution details
    steps_executed JSONB DEFAULT '[]'::jsonb, -- [{step_id: "...", status: "completed", result: {...}}]
    
    -- Error information
    error_message TEXT,
    error_details JSONB,
    retry_count INTEGER DEFAULT 0,
    
    -- Metadata
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Indexes for automation tables
CREATE INDEX idx_automated_actions_org ON public.automated_actions(organization_id);
CREATE INDEX idx_automated_actions_active ON public.automated_actions(organization_id, is_active) WHERE is_active = true;
CREATE INDEX idx_automated_actions_scheduled ON public.automated_actions(next_run_at) WHERE trigger_type = 'time_based' AND is_active = true;
CREATE INDEX idx_automated_action_steps_action ON public.automated_action_steps(action_id, step_order);
CREATE INDEX idx_automated_action_logs_action ON public.automated_action_logs(action_id, created_at DESC);
CREATE INDEX idx_automated_action_logs_org ON public.automated_action_logs(organization_id, created_at DESC);

-- Enable RLS
ALTER TABLE public.automated_actions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.automated_action_steps ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.automated_action_logs ENABLE ROW LEVEL SECURITY;

-- RLS Policies for automated_actions
CREATE POLICY "Users can view automated actions in their organization"
ON public.automated_actions FOR SELECT
USING (
    organization_id IN (SELECT organization_id FROM public.user_roles WHERE user_id = auth.uid() AND is_active = true)
);

CREATE POLICY "Admins can manage automated actions"
ON public.automated_actions FOR ALL
USING (
    organization_id IN (
        SELECT organization_id FROM public.user_roles 
        WHERE user_id = auth.uid() 
        AND role IN ('owner', 'admin', 'super_admin') 
        AND is_active = true
    )
);

-- RLS Policies for automated_action_steps
CREATE POLICY "Users can view automation steps"
ON public.automated_action_steps FOR SELECT
USING (
    action_id IN (
        SELECT id FROM public.automated_actions 
        WHERE organization_id IN (SELECT organization_id FROM public.user_roles WHERE user_id = auth.uid() AND is_active = true)
    )
);

CREATE POLICY "Admins can manage automation steps"
ON public.automated_action_steps FOR ALL
USING (
    action_id IN (
        SELECT id FROM public.automated_actions 
        WHERE organization_id IN (
            SELECT organization_id FROM public.user_roles 
            WHERE user_id = auth.uid() 
            AND role IN ('owner', 'admin', 'super_admin') 
            AND is_active = true
        )
    )
);

-- RLS Policies for automated_action_logs
CREATE POLICY "Users can view automation logs in their organization"
ON public.automated_action_logs FOR SELECT
USING (
    organization_id IN (SELECT organization_id FROM public.user_roles WHERE user_id = auth.uid() AND is_active = true)
);

CREATE POLICY "System can insert automation logs"
ON public.automated_action_logs FOR INSERT
WITH CHECK (true);

-- Triggers
CREATE TRIGGER update_automated_actions_updated_at
    BEFORE UPDATE ON public.automated_actions
    FOR EACH ROW
    EXECUTE FUNCTION public.update_updated_at_column();

CREATE TRIGGER update_automated_action_steps_updated_at
    BEFORE UPDATE ON public.automated_action_steps
    FOR EACH ROW
    EXECUTE FUNCTION public.update_updated_at_column();

-- ============================================
-- PHASE 4: Form Layout Designer
-- ============================================

-- Form Layouts (customizable form configurations)
CREATE TABLE public.form_layouts (
    id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
    organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
    
    -- Form identification
    entity_type VARCHAR(100) NOT NULL, -- invoice, contact, product, etc.
    layout_name VARCHAR(255) NOT NULL,
    is_default BOOLEAN DEFAULT false,
    
    -- Layout configuration
    layout_config JSONB NOT NULL DEFAULT '{}'::jsonb,
    -- Structure: {
    --   tabs: [{id: "tab1", label: "General", groups: ["group1", "group2"]}],
    --   groups: [{id: "group1", label: "Basic Info", columns: 2, fields: ["name", "email"]}],
    --   field_overrides: {name: {label: "Full Name", width: "full"}}
    -- }
    
    -- Metadata
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
    created_by UUID REFERENCES auth.users(id),
    
    CONSTRAINT form_layouts_unique UNIQUE (organization_id, entity_type, layout_name)
);

-- Form Conditional Rules (visibility/required rules for form fields)
CREATE TABLE public.form_conditional_rules (
    id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
    form_layout_id UUID NOT NULL REFERENCES public.form_layouts(id) ON DELETE CASCADE,
    
    -- Target field
    field_key VARCHAR(100) NOT NULL,
    
    -- Rule type
    rule_type VARCHAR(50) NOT NULL, -- visibility, required, readonly, value
    
    -- Condition
    condition_expression JSONB NOT NULL, -- {field: "type", operator: "=", value: "customer"}
    
    -- Action value (for value rules)
    action_value TEXT,
    
    -- Metadata
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Indexes
CREATE INDEX idx_form_layouts_org ON public.form_layouts(organization_id, entity_type);
CREATE INDEX idx_form_conditional_rules_layout ON public.form_conditional_rules(form_layout_id);

-- Enable RLS
ALTER TABLE public.form_layouts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.form_conditional_rules ENABLE ROW LEVEL SECURITY;

-- RLS Policies
CREATE POLICY "Users can view form layouts in their organization"
ON public.form_layouts FOR SELECT
USING (
    organization_id IN (SELECT organization_id FROM public.user_roles WHERE user_id = auth.uid() AND is_active = true)
);

CREATE POLICY "Admins can manage form layouts"
ON public.form_layouts FOR ALL
USING (
    organization_id IN (
        SELECT organization_id FROM public.user_roles 
        WHERE user_id = auth.uid() 
        AND role IN ('owner', 'admin', 'super_admin') 
        AND is_active = true
    )
);

CREATE POLICY "Users can view form conditional rules"
ON public.form_conditional_rules FOR SELECT
USING (
    form_layout_id IN (
        SELECT id FROM public.form_layouts 
        WHERE organization_id IN (SELECT organization_id FROM public.user_roles WHERE user_id = auth.uid() AND is_active = true)
    )
);

CREATE POLICY "Admins can manage form conditional rules"
ON public.form_conditional_rules FOR ALL
USING (
    form_layout_id IN (
        SELECT id FROM public.form_layouts 
        WHERE organization_id IN (
            SELECT organization_id FROM public.user_roles 
            WHERE user_id = auth.uid() 
            AND role IN ('owner', 'admin', 'super_admin') 
            AND is_active = true
        )
    )
);

-- Trigger
CREATE TRIGGER update_form_layouts_updated_at
    BEFORE UPDATE ON public.form_layouts
    FOR EACH ROW
    EXECUTE FUNCTION public.update_updated_at_column();

-- ============================================
-- PHASE 5: Saved Views System
-- ============================================

-- Saved Views (user-customized list/kanban/pivot views)
CREATE TABLE public.saved_views (
    id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
    organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
    user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
    
    -- View identification
    entity_type VARCHAR(100) NOT NULL,
    view_name VARCHAR(255) NOT NULL,
    view_type VARCHAR(50) NOT NULL DEFAULT 'list', -- list, kanban, pivot, chart, calendar, gantt
    
    -- Sharing
    is_shared BOOLEAN DEFAULT false,
    is_default BOOLEAN DEFAULT false,
    
    -- View configuration
    view_config JSONB NOT NULL DEFAULT '{}'::jsonb,
    -- For list: {columns: [...], sort: {field: "created_at", dir: "desc"}, filters: [...]}
    -- For kanban: {group_by: "status", columns: [...]}
    -- For pivot: {rows: ["product_id"], cols: ["month"], values: ["sum:total"]}
    -- For chart: {type: "bar", x: "month", y: "total", group_by: "status"}
    -- For calendar: {date_field: "due_date", title_field: "name", color_field: "status"}
    
    -- Quick filters
    quick_filters JSONB DEFAULT '[]'::jsonb, -- [{label: "Overdue", filters: [...]}]
    
    -- Metadata
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Indexes
CREATE INDEX idx_saved_views_org ON public.saved_views(organization_id, entity_type);
CREATE INDEX idx_saved_views_user ON public.saved_views(user_id, entity_type);
CREATE INDEX idx_saved_views_shared ON public.saved_views(organization_id, entity_type) WHERE is_shared = true;

-- Enable RLS
ALTER TABLE public.saved_views ENABLE ROW LEVEL SECURITY;

-- RLS Policies
CREATE POLICY "Users can view their own and shared views"
ON public.saved_views FOR SELECT
USING (
    (user_id = auth.uid() OR is_shared = true)
    AND organization_id IN (SELECT organization_id FROM public.user_roles WHERE user_id = auth.uid() AND is_active = true)
);

CREATE POLICY "Users can manage their own views"
ON public.saved_views FOR ALL
USING (
    user_id = auth.uid()
    AND organization_id IN (SELECT organization_id FROM public.user_roles WHERE user_id = auth.uid() AND is_active = true)
);

CREATE POLICY "Admins can manage all views in organization"
ON public.saved_views FOR ALL
USING (
    organization_id IN (
        SELECT organization_id FROM public.user_roles 
        WHERE user_id = auth.uid() 
        AND role IN ('owner', 'admin', 'super_admin') 
        AND is_active = true
    )
);

-- Trigger
CREATE TRIGGER update_saved_views_updated_at
    BEFORE UPDATE ON public.saved_views
    FOR EACH ROW
    EXECUTE FUNCTION public.update_updated_at_column();

-- ============================================
-- PHASE 6: Report Designer
-- ============================================

-- Report Templates
CREATE TABLE public.report_templates (
    id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
    organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
    
    -- Report identification
    report_name VARCHAR(255) NOT NULL,
    report_type VARCHAR(50) NOT NULL, -- invoice, statement, sales_report, custom
    
    -- Data source
    data_source_type VARCHAR(50) NOT NULL, -- entity, query
    data_source_entity VARCHAR(100), -- invoices, contacts, etc.
    data_source_query TEXT, -- custom SQL for advanced reports
    data_filters JSONB DEFAULT '[]'::jsonb,
    
    -- Template content
    template_html TEXT,
    template_css TEXT,
    header_html TEXT,
    footer_html TEXT,
    
    -- Page settings
    page_size VARCHAR(20) DEFAULT 'A4', -- A4, Letter, etc.
    page_orientation VARCHAR(20) DEFAULT 'portrait', -- portrait, landscape
    page_margins JSONB DEFAULT '{"top": 20, "right": 20, "bottom": 20, "left": 20}'::jsonb,
    
    -- Available fields for insertion
    available_fields JSONB DEFAULT '[]'::jsonb, -- [{key: "invoice_number", label: "Invoice #", type: "text"}]
    
    -- Sharing
    is_default BOOLEAN DEFAULT false,
    is_shared BOOLEAN DEFAULT false,
    
    -- Metadata
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
    created_by UUID REFERENCES auth.users(id)
);

-- Indexes
CREATE INDEX idx_report_templates_org ON public.report_templates(organization_id, report_type);

-- Enable RLS
ALTER TABLE public.report_templates ENABLE ROW LEVEL SECURITY;

-- RLS Policies
CREATE POLICY "Users can view report templates in their organization"
ON public.report_templates FOR SELECT
USING (
    organization_id IN (SELECT organization_id FROM public.user_roles WHERE user_id = auth.uid() AND is_active = true)
);

CREATE POLICY "Admins can manage report templates"
ON public.report_templates FOR ALL
USING (
    organization_id IN (
        SELECT organization_id FROM public.user_roles 
        WHERE user_id = auth.uid() 
        AND role IN ('owner', 'admin', 'super_admin') 
        AND is_active = true
    )
);

-- Trigger
CREATE TRIGGER update_report_templates_updated_at
    BEFORE UPDATE ON public.report_templates
    FOR EACH ROW
    EXECUTE FUNCTION public.update_updated_at_column();