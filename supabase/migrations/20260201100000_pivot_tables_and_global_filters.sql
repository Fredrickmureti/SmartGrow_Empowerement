-- Pivot Tables and Global Filters Migration
-- 
-- NOTE: The current implementation stores pivots and global filters in the
-- sheet's config JSON field, which is sufficient for most use cases.
-- This migration creates dedicated tables if you need:
-- - Advanced querying/filtering of pivots across sheets
-- - Separate RLS policies for pivot management
-- - Database-level indexing on pivot properties
-- 
-- If you're happy with the JSON-based storage in sheet config, you can skip this migration.

-- ============================================================================
-- Spreadsheet Pivots Table
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.spreadsheet_pivots (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    sheet_id UUID NOT NULL REFERENCES public.spreadsheet_sheets(id) ON DELETE CASCADE,
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
CREATE INDEX IF NOT EXISTS idx_spreadsheet_pivots_created_by ON public.spreadsheet_pivots(created_by);

-- Enable RLS
ALTER TABLE public.spreadsheet_pivots ENABLE ROW LEVEL SECURITY;

-- RLS policies for pivots (inherit from sheet permissions)
CREATE POLICY "Users can view pivots on accessible sheets" ON public.spreadsheet_pivots
    FOR SELECT USING (
        EXISTS (
            SELECT 1 FROM public.spreadsheet_sheets s
            JOIN public.spreadsheets sp ON s.spreadsheet_id = sp.id
            WHERE s.id = spreadsheet_pivots.sheet_id
            AND (sp.user_id = auth.uid() OR sp.organization_id IN (
                SELECT organization_id FROM public.profiles WHERE id = auth.uid()
            ))
        )
    );

CREATE POLICY "Users can create pivots on owned sheets" ON public.spreadsheet_pivots
    FOR INSERT WITH CHECK (
        EXISTS (
            SELECT 1 FROM public.spreadsheet_sheets s
            JOIN public.spreadsheets sp ON s.spreadsheet_id = sp.id
            WHERE s.id = spreadsheet_pivots.sheet_id
            AND sp.user_id = auth.uid()
        )
    );

CREATE POLICY "Users can update own pivots" ON public.spreadsheet_pivots
    FOR UPDATE USING (created_by = auth.uid());

CREATE POLICY "Users can delete own pivots" ON public.spreadsheet_pivots
    FOR DELETE USING (created_by = auth.uid());

-- ============================================================================
-- Global Filters Table
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.spreadsheet_global_filters (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    sheet_id UUID NOT NULL REFERENCES public.spreadsheet_sheets(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    label TEXT NOT NULL,
    field TEXT NOT NULL,
    type TEXT NOT NULL CHECK (type IN ('text', 'select', 'date')),
    options TEXT[],
    default_value TEXT,
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now(),
    created_by UUID REFERENCES auth.users(id),
    UNIQUE(sheet_id, name)
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_spreadsheet_global_filters_sheet_id ON public.spreadsheet_global_filters(sheet_id);

-- Enable RLS
ALTER TABLE public.spreadsheet_global_filters ENABLE ROW LEVEL SECURITY;

-- RLS policies for global filters
CREATE POLICY "Users can view filters on accessible sheets" ON public.spreadsheet_global_filters
    FOR SELECT USING (
        EXISTS (
            SELECT 1 FROM public.spreadsheet_sheets s
            JOIN public.spreadsheets sp ON s.spreadsheet_id = sp.id
            WHERE s.id = spreadsheet_global_filters.sheet_id
            AND (sp.user_id = auth.uid() OR sp.organization_id IN (
                SELECT organization_id FROM public.profiles WHERE id = auth.uid()
            ))
        )
    );

CREATE POLICY "Users can create filters on owned sheets" ON public.spreadsheet_global_filters
    FOR INSERT WITH CHECK (
        EXISTS (
            SELECT 1 FROM public.spreadsheet_sheets s
            JOIN public.spreadsheets sp ON s.spreadsheet_id = sp.id
            WHERE s.id = spreadsheet_global_filters.sheet_id
            AND sp.user_id = auth.uid()
        )
    );

CREATE POLICY "Users can update own filters" ON public.spreadsheet_global_filters
    FOR UPDATE USING (created_by = auth.uid());

CREATE POLICY "Users can delete own filters" ON public.spreadsheet_global_filters
    FOR DELETE USING (created_by = auth.uid());

-- ============================================================================
-- Filter-Pivot Mappings (which filters apply to which pivots)
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
            WHERE f.id = spreadsheet_filter_pivot_mappings.filter_id
            AND f.created_by = auth.uid()
        )
    );

CREATE POLICY "Users can manage filter-pivot mappings" ON public.spreadsheet_filter_pivot_mappings
    FOR ALL USING (
        EXISTS (
            SELECT 1 FROM public.spreadsheet_global_filters f
            WHERE f.id = spreadsheet_filter_pivot_mappings.filter_id
            AND f.created_by = auth.uid()
        )
    );

-- ============================================================================
-- User Filter Values (persisted filter selections per user)
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

CREATE POLICY "Users can manage own filter values" ON public.spreadsheet_user_filter_values
    FOR ALL USING (user_id = auth.uid());

-- ============================================================================
-- Updated timestamp triggers
-- ============================================================================
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$ language 'plpgsql';

DROP TRIGGER IF EXISTS update_spreadsheet_pivots_updated_at ON public.spreadsheet_pivots;
CREATE TRIGGER update_spreadsheet_pivots_updated_at
    BEFORE UPDATE ON public.spreadsheet_pivots
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS update_spreadsheet_global_filters_updated_at ON public.spreadsheet_global_filters;
CREATE TRIGGER update_spreadsheet_global_filters_updated_at
    BEFORE UPDATE ON public.spreadsheet_global_filters
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
