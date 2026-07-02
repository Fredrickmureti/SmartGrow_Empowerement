-- =====================================================
-- SPREADSHEET SHARING SYSTEM
-- Enables public access and email invitations
-- =====================================================

-- Create spreadsheet_shares table for managing access
CREATE TABLE public.spreadsheet_shares (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  spreadsheet_id UUID NOT NULL REFERENCES public.spreadsheets(id) ON DELETE CASCADE,
  email TEXT,                           -- NULL for public link (is_public mode)
  permission TEXT NOT NULL DEFAULT 'view' CHECK (permission IN ('view', 'edit', 'admin')),
  access_token TEXT UNIQUE DEFAULT gen_random_uuid()::text,
  created_by UUID REFERENCES auth.users(id),
  expires_at TIMESTAMPTZ,               -- Optional expiration
  accepted_at TIMESTAMPTZ,              -- When user first accessed
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- Indexes for fast lookups
CREATE INDEX idx_spreadsheet_shares_spreadsheet ON public.spreadsheet_shares(spreadsheet_id);
CREATE INDEX idx_spreadsheet_shares_token ON public.spreadsheet_shares(access_token);
CREATE INDEX idx_spreadsheet_shares_email ON public.spreadsheet_shares(email) WHERE email IS NOT NULL;

-- Enable RLS
ALTER TABLE public.spreadsheet_shares ENABLE ROW LEVEL SECURITY;

-- Organization members can manage shares for their spreadsheets
CREATE POLICY "Org members can manage shares"
ON public.spreadsheet_shares FOR ALL
TO authenticated
USING (
  spreadsheet_id IN (
    SELECT id FROM public.spreadsheets WHERE organization_id IN (
      SELECT organization_id FROM public.user_roles WHERE user_id = auth.uid() AND is_active = true
    )
  )
)
WITH CHECK (
  spreadsheet_id IN (
    SELECT id FROM public.spreadsheets WHERE organization_id IN (
      SELECT organization_id FROM public.user_roles WHERE user_id = auth.uid() AND is_active = true
    )
  )
);

-- Anyone can read share records (token validation done in edge function)
-- This allows the edge function to look up tokens
CREATE POLICY "Anyone can view shares for validation"
ON public.spreadsheet_shares FOR SELECT
TO anon, authenticated
USING (true);

-- =====================================================
-- UPDATE SPREADSHEETS RLS FOR PUBLIC ACCESS
-- =====================================================

-- Add policy for anonymous access to public spreadsheets
CREATE POLICY "Anyone can view public spreadsheets"
ON public.spreadsheets FOR SELECT
TO anon
USING (is_public = true);

-- Add policy for token-based access (for invited users without org membership)
CREATE POLICY "Token holders can view shared spreadsheets"
ON public.spreadsheets FOR SELECT
TO anon, authenticated
USING (
  id IN (
    SELECT spreadsheet_id FROM public.spreadsheet_shares 
    WHERE access_token IS NOT NULL
    AND (expires_at IS NULL OR expires_at > now())
  )
);

-- =====================================================
-- SHEETS ACCESS FOR PUBLIC/SHARED SPREADSHEETS
-- =====================================================

-- Allow reading sheets for public spreadsheets
CREATE POLICY "Anyone can view sheets of public spreadsheets"
ON public.spreadsheet_sheets FOR SELECT
TO anon
USING (
  spreadsheet_id IN (SELECT id FROM public.spreadsheets WHERE is_public = true)
);

-- Allow reading sheets via token access
CREATE POLICY "Token holders can view shared spreadsheet sheets"
ON public.spreadsheet_sheets FOR SELECT
TO anon, authenticated
USING (
  spreadsheet_id IN (
    SELECT spreadsheet_id FROM public.spreadsheet_shares 
    WHERE access_token IS NOT NULL
    AND (expires_at IS NULL OR expires_at > now())
  )
);

-- Allow updating sheets for edit permission tokens
-- Note: The actual permission check is done in the edge function for security
CREATE POLICY "Token edit access for sheets"
ON public.spreadsheet_sheets FOR UPDATE
TO anon, authenticated
USING (
  spreadsheet_id IN (
    SELECT spreadsheet_id FROM public.spreadsheet_shares 
    WHERE permission IN ('edit', 'admin')
    AND (expires_at IS NULL OR expires_at > now())
  )
)
WITH CHECK (
  spreadsheet_id IN (
    SELECT spreadsheet_id FROM public.spreadsheet_shares 
    WHERE permission IN ('edit', 'admin')
    AND (expires_at IS NULL OR expires_at > now())
  )
);

-- =====================================================
-- DATA SOURCES ACCESS FOR PUBLIC/SHARED
-- =====================================================

-- Allow reading data sources for public spreadsheets
CREATE POLICY "Anyone can view data sources of public spreadsheets"
ON public.spreadsheet_data_sources FOR SELECT
TO anon
USING (
  spreadsheet_id IN (SELECT id FROM public.spreadsheets WHERE is_public = true)
);

-- Allow reading data sources via token
CREATE POLICY "Token holders can view shared data sources"
ON public.spreadsheet_data_sources FOR SELECT
TO anon, authenticated
USING (
  spreadsheet_id IN (
    SELECT spreadsheet_id FROM public.spreadsheet_shares 
    WHERE access_token IS NOT NULL
    AND (expires_at IS NULL OR expires_at > now())
  )
);