-- ============================================================================
-- SPREADSHEET ENTERPRISE ENHANCEMENT MIGRATION
-- ============================================================================
-- This migration adds:
-- 1. spreadsheet_versions table for Version History (Phase 4)
-- 2. spreadsheet_pivots table for Pivot Tables (Phase 2)
-- 3. spreadsheet_global_filters table for Dashboard Filters (Phase 3)
-- 4. spreadsheet_filter_pivot_mappings for filter-pivot relationships
-- 5. spreadsheet_user_filter_values for persisting user filter selections
-- 6. spreadsheet_validation_rules for Data Validation (Phase 5)
-- ============================================================================

-- ============================================================================
-- 1. SPREADSHEET VERSIONS TABLE (Phase 4 - Version History)
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.spreadsheet_versions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    sheet_id UUID NOT NULL REFERENCES public.spreadsheet_sheets(id) ON DELETE CASCADE,
    config JSONB NOT NULL,
    created_by UUID REFERENCES auth.users(id),
    created_at TIMESTAMPTZ DEFAULT now(),
    comment TEXT,
    version_number INTEGER,
    is_auto_save BOOLEAN DEFAULT false
);

-- Indexes for efficient version queries
CREATE INDEX IF NOT EXISTS idx_spreadsheet_versions_sheet_id ON public.spreadsheet_versions(sheet_id);
CREATE INDEX IF NOT EXISTS idx_spreadsheet_versions_created_at ON public.spreadsheet_versions(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_spreadsheet_versions_created_by ON public.spreadsheet_versions(created_by);

-- Enable RLS
ALTER TABLE public.spreadsheet_versions ENABLE ROW LEVEL SECURITY;

-- RLS policies for versions (inherit from sheet permissions via user_roles)
CREATE POLICY "Users can view versions of accessible spreadsheets" ON public.spreadsheet_versions
    FOR SELECT USING (
        EXISTS (
            SELECT 1 FROM public.spreadsheet_sheets ss
            JOIN public.spreadsheets s ON ss.spreadsheet_id = s.id
            WHERE ss.id = spreadsheet_versions.sheet_id
            AND s.organization_id IN (
                SELECT organization_id FROM public.user_roles 
                WHERE user_id = auth.uid() AND is_active = true
            )
        )
    );

CREATE POLICY "Users can create versions for accessible spreadsheets" ON public.spreadsheet_versions
    FOR INSERT WITH CHECK (
        EXISTS (
            SELECT 1 FROM public.spreadsheet_sheets ss
            JOIN public.spreadsheets s ON ss.spreadsheet_id = s.id
            WHERE ss.id = spreadsheet_versions.sheet_id
            AND s.organization_id IN (
                SELECT organization_id FROM public.user_roles 
                WHERE user_id = auth.uid() AND is_active = true
            )
        )
    );

CREATE POLICY "Users can delete own versions" ON public.spreadsheet_versions
    FOR DELETE USING (created_by = auth.uid());

-- ============================================================================
-- 2. SPREADSHEET PIVOTS TABLE (Phase 2 - Pivot Tables)
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.spreadsheet_pivots (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    sheet_id UUID NOT NULL REFERENCES public.spreadsheet_sheets(id) ON DELETE CASCADE,
    organization_id UUID REFERENCES public.organizations(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    source_range TEXT NOT NULL,
    row_group_by TEXT[] DEFAULT '{}',
    col_group_by TEXT[] DEFAULT '{}',
    measures JSONB NOT NULL DEFAULT '[]',
    anchor_cell TEXT NOT NULL,
    show_row_totals BOOLEAN DEFAULT true,
    show_col_totals BOOLEAN DEFAULT true,
    show_grand_total BOOLEAN DEFAULT true,
    last_rendered JSONB,
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now(),
    created_by UUID REFERENCES auth.users(id),
    UNIQUE(sheet_id, name)
);

-- Indexes for efficient querying
CREATE INDEX IF NOT EXISTS idx_spreadsheet_pivots_sheet_id ON public.spreadsheet_pivots(sheet_id);
CREATE INDEX IF NOT EXISTS idx_spreadsheet_pivots_org_id ON public.spreadsheet_pivots(organization_id);
CREATE INDEX IF NOT EXISTS idx_spreadsheet_pivots_created_by ON public.spreadsheet_pivots(created_by);

-- Enable RLS
ALTER TABLE public.spreadsheet_pivots ENABLE ROW LEVEL SECURITY;

-- RLS policies for pivots (organization-based using user_roles)
CREATE POLICY "Users can view pivots in their organization" ON public.spreadsheet_pivots
    FOR SELECT USING (
        organization_id IN (
            SELECT organization_id FROM public.user_roles 
            WHERE user_id = auth.uid() AND is_active = true
        )
    );

CREATE POLICY "Users can create pivots in their organization" ON public.spreadsheet_pivots
    FOR INSERT WITH CHECK (
        organization_id IN (
            SELECT organization_id FROM public.user_roles 
            WHERE user_id = auth.uid() AND is_active = true
        )
    );

CREATE POLICY "Users can update pivots in their organization" ON public.spreadsheet_pivots
    FOR UPDATE USING (
        organization_id IN (
            SELECT organization_id FROM public.user_roles 
            WHERE user_id = auth.uid() AND is_active = true
        )
    );

CREATE POLICY "Users can delete pivots in their organization" ON public.spreadsheet_pivots
    FOR DELETE USING (
        organization_id IN (
            SELECT organization_id FROM public.user_roles 
            WHERE user_id = auth.uid() AND is_active = true
        )
    );

-- ============================================================================
-- 3. SPREADSHEET GLOBAL FILTERS TABLE (Phase 3 - Dashboard Builder)
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.spreadsheet_global_filters (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    sheet_id UUID NOT NULL REFERENCES public.spreadsheet_sheets(id) ON DELETE CASCADE,
    organization_id UUID REFERENCES public.organizations(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    label TEXT NOT NULL,
    field TEXT NOT NULL,
    type TEXT NOT NULL CHECK (type IN ('text', 'select', 'date', 'number', 'date_range')),
    options TEXT[],
    default_value TEXT,
    sort_order INTEGER DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now(),
    created_by UUID REFERENCES auth.users(id),
    UNIQUE(sheet_id, name)
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_spreadsheet_global_filters_sheet_id ON public.spreadsheet_global_filters(sheet_id);
CREATE INDEX IF NOT EXISTS idx_spreadsheet_global_filters_org_id ON public.spreadsheet_global_filters(organization_id);

-- Enable RLS
ALTER TABLE public.spreadsheet_global_filters ENABLE ROW LEVEL SECURITY;

-- RLS policies for global filters (organization-based using user_roles)
CREATE POLICY "Users can view filters in their organization" ON public.spreadsheet_global_filters
    FOR SELECT USING (
        organization_id IN (
            SELECT organization_id FROM public.user_roles 
            WHERE user_id = auth.uid() AND is_active = true
        )
    );

CREATE POLICY "Users can create filters in their organization" ON public.spreadsheet_global_filters
    FOR INSERT WITH CHECK (
        organization_id IN (
            SELECT organization_id FROM public.user_roles 
            WHERE user_id = auth.uid() AND is_active = true
        )
    );

CREATE POLICY "Users can update filters in their organization" ON public.spreadsheet_global_filters
    FOR UPDATE USING (
        organization_id IN (
            SELECT organization_id FROM public.user_roles 
            WHERE user_id = auth.uid() AND is_active = true
        )
    );

CREATE POLICY "Users can delete filters in their organization" ON public.spreadsheet_global_filters
    FOR DELETE USING (
        organization_id IN (
            SELECT organization_id FROM public.user_roles 
            WHERE user_id = auth.uid() AND is_active = true
        )
    );

-- ============================================================================
-- 4. FILTER-PIVOT MAPPINGS (which filters apply to which pivots)
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.spreadsheet_filter_pivot_mappings (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    filter_id UUID NOT NULL REFERENCES public.spreadsheet_global_filters(id) ON DELETE CASCADE,
    pivot_id UUID NOT NULL REFERENCES public.spreadsheet_pivots(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ DEFAULT now(),
    UNIQUE(filter_id, pivot_id)
);

-- Enable RLS
ALTER TABLE public.spreadsheet_filter_pivot_mappings ENABLE ROW LEVEL SECURITY;

-- RLS policies for mappings (inherit from filter permissions)
CREATE POLICY "Users can view filter-pivot mappings" ON public.spreadsheet_filter_pivot_mappings
    FOR SELECT USING (
        EXISTS (
            SELECT 1 FROM public.spreadsheet_global_filters f
            JOIN public.user_roles ur ON f.organization_id = ur.organization_id
            WHERE f.id = spreadsheet_filter_pivot_mappings.filter_id
            AND ur.user_id = auth.uid() AND ur.is_active = true
        )
    );

CREATE POLICY "Users can manage filter-pivot mappings" ON public.spreadsheet_filter_pivot_mappings
    FOR ALL USING (
        EXISTS (
            SELECT 1 FROM public.spreadsheet_global_filters f
            JOIN public.user_roles ur ON f.organization_id = ur.organization_id
            WHERE f.id = spreadsheet_filter_pivot_mappings.filter_id
            AND ur.user_id = auth.uid() AND ur.is_active = true
        )
    );

-- ============================================================================
-- 5. USER FILTER VALUES (persisted filter selections per user)
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.spreadsheet_user_filter_values (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    filter_id UUID NOT NULL REFERENCES public.spreadsheet_global_filters(id) ON DELETE CASCADE,
    value TEXT,
    updated_at TIMESTAMPTZ DEFAULT now(),
    UNIQUE(user_id, filter_id)
);

-- Enable RLS
ALTER TABLE public.spreadsheet_user_filter_values ENABLE ROW LEVEL SECURITY;

-- RLS policies for user filter values
CREATE POLICY "Users can view own filter values" ON public.spreadsheet_user_filter_values
    FOR SELECT USING (user_id = auth.uid());

CREATE POLICY "Users can insert own filter values" ON public.spreadsheet_user_filter_values
    FOR INSERT WITH CHECK (user_id = auth.uid());

CREATE POLICY "Users can update own filter values" ON public.spreadsheet_user_filter_values
    FOR UPDATE USING (user_id = auth.uid());

CREATE POLICY "Users can delete own filter values" ON public.spreadsheet_user_filter_values
    FOR DELETE USING (user_id = auth.uid());

-- ============================================================================
-- 6. SPREADSHEET VALIDATION RULES TABLE (Phase 5 - Data Validation)
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.spreadsheet_validation_rules (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    sheet_id UUID NOT NULL REFERENCES public.spreadsheet_sheets(id) ON DELETE CASCADE,
    organization_id UUID REFERENCES public.organizations(id) ON DELETE CASCADE,
    cell_range TEXT NOT NULL,
    validation_type TEXT NOT NULL CHECK (validation_type IN ('list', 'number', 'date', 'text_length', 'custom_formula')),
    config JSONB NOT NULL DEFAULT '{}',
    error_message TEXT,
    error_style TEXT DEFAULT 'stop' CHECK (error_style IN ('stop', 'warning', 'info')),
    show_dropdown BOOLEAN DEFAULT true,
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now(),
    created_by UUID REFERENCES auth.users(id)
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_spreadsheet_validation_rules_sheet_id ON public.spreadsheet_validation_rules(sheet_id);
CREATE INDEX IF NOT EXISTS idx_spreadsheet_validation_rules_org_id ON public.spreadsheet_validation_rules(organization_id);

-- Enable RLS
ALTER TABLE public.spreadsheet_validation_rules ENABLE ROW LEVEL SECURITY;

-- RLS policies for validation rules (organization-based using user_roles)
CREATE POLICY "Users can view validation rules in their organization" ON public.spreadsheet_validation_rules
    FOR SELECT USING (
        organization_id IN (
            SELECT organization_id FROM public.user_roles 
            WHERE user_id = auth.uid() AND is_active = true
        )
    );

CREATE POLICY "Users can create validation rules in their organization" ON public.spreadsheet_validation_rules
    FOR INSERT WITH CHECK (
        organization_id IN (
            SELECT organization_id FROM public.user_roles 
            WHERE user_id = auth.uid() AND is_active = true
        )
    );

CREATE POLICY "Users can update validation rules in their organization" ON public.spreadsheet_validation_rules
    FOR UPDATE USING (
        organization_id IN (
            SELECT organization_id FROM public.user_roles 
            WHERE user_id = auth.uid() AND is_active = true
        )
    );

CREATE POLICY "Users can delete validation rules in their organization" ON public.spreadsheet_validation_rules
    FOR DELETE USING (
        organization_id IN (
            SELECT organization_id FROM public.user_roles 
            WHERE user_id = auth.uid() AND is_active = true
        )
    );

-- ============================================================================
-- 7. UPDATED TIMESTAMP TRIGGERS
-- ============================================================================
-- Create the function if it doesn't exist
CREATE OR REPLACE FUNCTION public.update_spreadsheet_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = public;

-- Create triggers for updated_at columns
DROP TRIGGER IF EXISTS update_spreadsheet_pivots_updated_at ON public.spreadsheet_pivots;
CREATE TRIGGER update_spreadsheet_pivots_updated_at
    BEFORE UPDATE ON public.spreadsheet_pivots
    FOR EACH ROW EXECUTE FUNCTION public.update_spreadsheet_updated_at();

DROP TRIGGER IF EXISTS update_spreadsheet_global_filters_updated_at ON public.spreadsheet_global_filters;
CREATE TRIGGER update_spreadsheet_global_filters_updated_at
    BEFORE UPDATE ON public.spreadsheet_global_filters
    FOR EACH ROW EXECUTE FUNCTION public.update_spreadsheet_updated_at();

DROP TRIGGER IF EXISTS update_spreadsheet_validation_rules_updated_at ON public.spreadsheet_validation_rules;
CREATE TRIGGER update_spreadsheet_validation_rules_updated_at
    BEFORE UPDATE ON public.spreadsheet_validation_rules
    FOR EACH ROW EXECUTE FUNCTION public.update_spreadsheet_updated_at();

-- ============================================================================
-- 8. VERSION CLEANUP FUNCTION (Optional - for 30-day retention)
-- ============================================================================
CREATE OR REPLACE FUNCTION public.cleanup_old_spreadsheet_versions()
RETURNS INTEGER AS $$
DECLARE
    deleted_count INTEGER;
BEGIN
    DELETE FROM public.spreadsheet_versions 
    WHERE created_at < NOW() - INTERVAL '30 days'
    AND is_auto_save = true;
    
    GET DIAGNOSTICS deleted_count = ROW_COUNT;
    RETURN deleted_count;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- ============================================================================
-- 9. ENABLE REALTIME FOR COLLABORATION
-- ============================================================================
-- Note: This may already be enabled, so we use a DO block to handle errors
DO $$
BEGIN
    ALTER PUBLICATION supabase_realtime ADD TABLE spreadsheet_versions;
EXCEPTION WHEN duplicate_object THEN
    NULL;
END $$;

DO $$
BEGIN
    ALTER PUBLICATION supabase_realtime ADD TABLE spreadsheet_pivots;
EXCEPTION WHEN duplicate_object THEN
    NULL;
END $$;

DO $$
BEGIN
    ALTER PUBLICATION supabase_realtime ADD TABLE spreadsheet_global_filters;
EXCEPTION WHEN duplicate_object THEN
    NULL;
END $$;

DO $$
BEGIN
    ALTER PUBLICATION supabase_realtime ADD TABLE spreadsheet_validation_rules;
EXCEPTION WHEN duplicate_object THEN
    NULL;
END $$;