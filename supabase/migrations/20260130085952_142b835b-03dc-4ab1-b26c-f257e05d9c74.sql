-- =============================================
-- PHASE 2: DOCUMENTS APP
-- =============================================

-- Document folders (hierarchical organization)
CREATE TABLE public.documents_folders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  business_id UUID REFERENCES public.businesses(id) ON DELETE SET NULL,
  parent_id UUID REFERENCES public.documents_folders(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  description TEXT,
  color TEXT DEFAULT '#3b82f6',
  icon TEXT DEFAULT 'folder',
  access_type TEXT DEFAULT 'internal' CHECK (access_type IN ('internal', 'portal', 'public')),
  sort_order INTEGER DEFAULT 0,
  created_by UUID,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- Folder tags for categorization
CREATE TABLE public.documents_folder_tags (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  folder_id UUID NOT NULL REFERENCES public.documents_folders(id) ON DELETE CASCADE,
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  color TEXT DEFAULT '#6b7280',
  sort_order INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Main documents table
CREATE TABLE public.documents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  business_id UUID REFERENCES public.businesses(id) ON DELETE SET NULL,
  folder_id UUID REFERENCES public.documents_folders(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  description TEXT,
  file_path TEXT, -- Supabase storage path
  file_type TEXT, -- 'pdf', 'image', 'spreadsheet', 'document', 'other'
  file_size BIGINT,
  mime_type TEXT,
  is_link BOOLEAN DEFAULT false,
  link_url TEXT,
  thumbnail_path TEXT,
  version INTEGER DEFAULT 1,
  status TEXT DEFAULT 'active' CHECK (status IN ('active', 'archived', 'deleted')),
  deleted_at TIMESTAMPTZ,
  owner_id UUID,
  locked_by UUID,
  locked_at TIMESTAMPTZ,
  -- Linked records for cross-module integration
  linked_entity_type TEXT, -- 'invoice', 'bill', 'contact', 'project', 'employee', 'expense'
  linked_entity_id UUID,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- Document tags (many-to-many)
CREATE TABLE public.documents_document_tags (
  document_id UUID NOT NULL REFERENCES public.documents(id) ON DELETE CASCADE,
  tag_id UUID NOT NULL REFERENCES public.documents_folder_tags(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ DEFAULT now(),
  PRIMARY KEY (document_id, tag_id)
);

-- Document activities (audit log for documents)
CREATE TABLE public.documents_activities (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id UUID NOT NULL REFERENCES public.documents(id) ON DELETE CASCADE,
  user_id UUID,
  action TEXT NOT NULL CHECK (action IN ('created', 'viewed', 'downloaded', 'edited', 'shared', 'commented', 'tagged', 'moved', 'renamed', 'locked', 'unlocked', 'deleted', 'restored')),
  details JSONB,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Document shares for external access
CREATE TABLE public.documents_shares (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  document_id UUID REFERENCES public.documents(id) ON DELETE CASCADE,
  folder_id UUID REFERENCES public.documents_folders(id) ON DELETE CASCADE,
  share_token TEXT NOT NULL UNIQUE,
  password_hash TEXT,
  expires_at TIMESTAMPTZ,
  allow_download BOOLEAN DEFAULT true,
  allow_upload BOOLEAN DEFAULT false,
  max_downloads INTEGER,
  download_count INTEGER DEFAULT 0,
  created_by UUID,
  created_at TIMESTAMPTZ DEFAULT now(),
  -- Must have either document_id or folder_id
  CONSTRAINT documents_shares_target CHECK (document_id IS NOT NULL OR folder_id IS NOT NULL)
);

-- Document workflow actions (automated actions per folder)
CREATE TABLE public.documents_workflow_actions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  folder_id UUID NOT NULL REFERENCES public.documents_folders(id) ON DELETE CASCADE,
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  action_type TEXT NOT NULL CHECK (action_type IN ('create_bill', 'create_expense', 'request_signature', 'move_folder', 'add_tag', 'notify', 'ocr_extract')),
  action_config JSONB DEFAULT '{}',
  is_active BOOLEAN DEFAULT true,
  sort_order INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- Document requests (placeholders for missing documents)
CREATE TABLE public.documents_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  folder_id UUID REFERENCES public.documents_folders(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  description TEXT,
  requested_from_email TEXT,
  requested_from_name TEXT,
  status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'uploaded', 'expired', 'cancelled')),
  due_date DATE,
  request_token TEXT UNIQUE,
  created_by UUID,
  fulfilled_document_id UUID REFERENCES public.documents(id) ON DELETE SET NULL,
  fulfilled_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Document versions for version control
CREATE TABLE public.documents_versions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id UUID NOT NULL REFERENCES public.documents(id) ON DELETE CASCADE,
  version_number INTEGER NOT NULL,
  file_path TEXT NOT NULL,
  file_size BIGINT,
  comment TEXT,
  created_by UUID,
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE (document_id, version_number)
);

-- Comments on documents
CREATE TABLE public.documents_comments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id UUID NOT NULL REFERENCES public.documents(id) ON DELETE CASCADE,
  user_id UUID,
  parent_id UUID REFERENCES public.documents_comments(id) ON DELETE CASCADE,
  content TEXT NOT NULL,
  is_resolved BOOLEAN DEFAULT false,
  resolved_by UUID,
  resolved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- =============================================
-- PHASE 3: SIGN APP
-- =============================================

-- Signature templates (reusable document templates with fields)
CREATE TABLE public.signature_templates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT,
  document_id UUID REFERENCES public.documents(id) ON DELETE SET NULL,
  original_file_path TEXT,
  fields_config JSONB DEFAULT '[]', -- Pre-configured signature fields
  signer_roles JSONB DEFAULT '[]', -- Predefined roles
  is_active BOOLEAN DEFAULT true,
  created_by UUID,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- Signature requests
CREATE TABLE public.signature_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  template_id UUID REFERENCES public.signature_templates(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  description TEXT,
  document_id UUID REFERENCES public.documents(id) ON DELETE SET NULL,
  original_file_path TEXT, -- If not linked to documents
  signed_file_path TEXT,
  status TEXT DEFAULT 'draft' CHECK (status IN ('draft', 'sent', 'in_progress', 'completed', 'cancelled', 'expired', 'declined')),
  signing_order TEXT DEFAULT 'parallel' CHECK (signing_order IN ('parallel', 'sequential')),
  expires_at TIMESTAMPTZ,
  reminder_frequency INTEGER DEFAULT 3, -- Days between reminders
  last_reminder_at TIMESTAMPTZ,
  created_by UUID,
  created_at TIMESTAMPTZ DEFAULT now(),
  completed_at TIMESTAMPTZ
);

-- Signers for signature requests
CREATE TABLE public.signature_signers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id UUID NOT NULL REFERENCES public.signature_requests(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  phone TEXT,
  role TEXT DEFAULT 'signer' CHECK (role IN ('signer', 'approver', 'cc', 'witness')),
  order_number INTEGER DEFAULT 1, -- For sequential signing
  status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'viewed', 'signed', 'declined')),
  access_token TEXT UNIQUE,
  require_sms_verification BOOLEAN DEFAULT false,
  viewed_at TIMESTAMPTZ,
  signed_at TIMESTAMPTZ,
  declined_at TIMESTAMPTZ,
  decline_reason TEXT,
  ip_address TEXT,
  geolocation JSONB,
  user_agent TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Signature fields on documents
CREATE TABLE public.signature_fields (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id UUID NOT NULL REFERENCES public.signature_requests(id) ON DELETE CASCADE,
  signer_id UUID REFERENCES public.signature_signers(id) ON DELETE CASCADE,
  field_type TEXT NOT NULL CHECK (field_type IN ('signature', 'initials', 'date', 'text', 'checkbox', 'name', 'email', 'company')),
  page_number INTEGER NOT NULL DEFAULT 1,
  position_x NUMERIC NOT NULL,
  position_y NUMERIC NOT NULL,
  width NUMERIC DEFAULT 200,
  height NUMERIC DEFAULT 50,
  is_required BOOLEAN DEFAULT true,
  placeholder TEXT,
  value TEXT, -- Filled value after signing
  font_size INTEGER DEFAULT 14,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Signature audit log (compliance tracking)
CREATE TABLE public.signature_audit_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id UUID NOT NULL REFERENCES public.signature_requests(id) ON DELETE CASCADE,
  signer_id UUID REFERENCES public.signature_signers(id) ON DELETE SET NULL,
  action TEXT NOT NULL, -- 'created', 'sent', 'viewed', 'signed', 'declined', 'completed', 'reminder_sent'
  ip_address TEXT,
  geolocation JSONB,
  user_agent TEXT,
  details JSONB,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- =============================================
-- PHASE 4: SPREADSHEET/BI APP
-- =============================================

-- Spreadsheets (saved BI configurations)
CREATE TABLE public.spreadsheets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  business_id UUID REFERENCES public.businesses(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  description TEXT,
  is_template BOOLEAN DEFAULT false,
  is_public BOOLEAN DEFAULT false,
  config JSONB DEFAULT '{}', -- Contains sheets, cells, formulas, styling
  thumbnail_path TEXT,
  last_modified_by UUID,
  created_by UUID,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- Spreadsheet sheets (tabs within a spreadsheet)
CREATE TABLE public.spreadsheet_sheets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  spreadsheet_id UUID NOT NULL REFERENCES public.spreadsheets(id) ON DELETE CASCADE,
  name TEXT NOT NULL DEFAULT 'Sheet 1',
  sort_order INTEGER DEFAULT 0,
  config JSONB DEFAULT '{}', -- Grid config, frozen rows/cols, column widths
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- Data sources for live data integration
CREATE TABLE public.spreadsheet_data_sources (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  spreadsheet_id UUID NOT NULL REFERENCES public.spreadsheets(id) ON DELETE CASCADE,
  sheet_id UUID REFERENCES public.spreadsheet_sheets(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  source_type TEXT NOT NULL CHECK (source_type IN ('invoices', 'bills', 'products', 'contacts', 'transactions', 'employees', 'custom_query', 'pos_transactions')),
  query_config JSONB DEFAULT '{}', -- Filters, date range, columns
  cell_range TEXT, -- e.g., 'A1:D100' - where to insert data
  refresh_interval INTEGER, -- Minutes, null = manual only
  last_refreshed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Dashboard pins (spreadsheet charts on dashboard)
CREATE TABLE public.dashboard_spreadsheet_pins (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  spreadsheet_id UUID NOT NULL REFERENCES public.spreadsheets(id) ON DELETE CASCADE,
  chart_config JSONB DEFAULT '{}', -- Which chart/view to show
  position_x INTEGER DEFAULT 0,
  position_y INTEGER DEFAULT 0,
  width INTEGER DEFAULT 2,
  height INTEGER DEFAULT 2,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- =============================================
-- INDEXES
-- =============================================

CREATE INDEX idx_documents_folders_org ON public.documents_folders(organization_id);
CREATE INDEX idx_documents_folders_parent ON public.documents_folders(parent_id);
CREATE INDEX idx_documents_org ON public.documents(organization_id);
CREATE INDEX idx_documents_folder ON public.documents(folder_id);
CREATE INDEX idx_documents_status ON public.documents(status);
CREATE INDEX idx_documents_linked ON public.documents(linked_entity_type, linked_entity_id);
CREATE INDEX idx_documents_activities_doc ON public.documents_activities(document_id);
CREATE INDEX idx_documents_shares_token ON public.documents_shares(share_token);
CREATE INDEX idx_signature_requests_org ON public.signature_requests(organization_id);
CREATE INDEX idx_signature_requests_status ON public.signature_requests(status);
CREATE INDEX idx_signature_signers_token ON public.signature_signers(access_token);
CREATE INDEX idx_spreadsheets_org ON public.spreadsheets(organization_id);

-- =============================================
-- RLS POLICIES
-- =============================================

ALTER TABLE public.documents_folders ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.documents_folder_tags ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.documents_document_tags ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.documents_activities ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.documents_shares ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.documents_workflow_actions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.documents_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.documents_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.documents_comments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.signature_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.signature_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.signature_signers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.signature_fields ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.signature_audit_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.spreadsheets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.spreadsheet_sheets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.spreadsheet_data_sources ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.dashboard_spreadsheet_pins ENABLE ROW LEVEL SECURITY;

-- Documents Folders RLS
CREATE POLICY "Users can view folders in their organization"
  ON public.documents_folders FOR SELECT
  USING (organization_id IN (SELECT organization_id FROM public.user_roles WHERE user_id = auth.uid() AND is_active = true));

CREATE POLICY "Users can create folders in their organization"
  ON public.documents_folders FOR INSERT
  WITH CHECK (organization_id IN (SELECT organization_id FROM public.user_roles WHERE user_id = auth.uid() AND is_active = true));

CREATE POLICY "Users can update folders in their organization"
  ON public.documents_folders FOR UPDATE
  USING (organization_id IN (SELECT organization_id FROM public.user_roles WHERE user_id = auth.uid() AND is_active = true));

CREATE POLICY "Users can delete folders in their organization"
  ON public.documents_folders FOR DELETE
  USING (organization_id IN (SELECT organization_id FROM public.user_roles WHERE user_id = auth.uid() AND is_active = true));

-- Documents RLS
CREATE POLICY "Users can view documents in their organization"
  ON public.documents FOR SELECT
  USING (organization_id IN (SELECT organization_id FROM public.user_roles WHERE user_id = auth.uid() AND is_active = true));

CREATE POLICY "Users can create documents in their organization"
  ON public.documents FOR INSERT
  WITH CHECK (organization_id IN (SELECT organization_id FROM public.user_roles WHERE user_id = auth.uid() AND is_active = true));

CREATE POLICY "Users can update documents in their organization"
  ON public.documents FOR UPDATE
  USING (organization_id IN (SELECT organization_id FROM public.user_roles WHERE user_id = auth.uid() AND is_active = true));

CREATE POLICY "Users can delete documents in their organization"
  ON public.documents FOR DELETE
  USING (organization_id IN (SELECT organization_id FROM public.user_roles WHERE user_id = auth.uid() AND is_active = true));

-- Folder Tags RLS
CREATE POLICY "Users can view folder tags in their organization"
  ON public.documents_folder_tags FOR SELECT
  USING (organization_id IN (SELECT organization_id FROM public.user_roles WHERE user_id = auth.uid() AND is_active = true));

CREATE POLICY "Users can manage folder tags in their organization"
  ON public.documents_folder_tags FOR ALL
  USING (organization_id IN (SELECT organization_id FROM public.user_roles WHERE user_id = auth.uid() AND is_active = true));

-- Document Tags RLS
CREATE POLICY "Users can view document tags"
  ON public.documents_document_tags FOR SELECT
  USING (document_id IN (SELECT id FROM public.documents WHERE organization_id IN (SELECT organization_id FROM public.user_roles WHERE user_id = auth.uid() AND is_active = true)));

CREATE POLICY "Users can manage document tags"
  ON public.documents_document_tags FOR ALL
  USING (document_id IN (SELECT id FROM public.documents WHERE organization_id IN (SELECT organization_id FROM public.user_roles WHERE user_id = auth.uid() AND is_active = true)));

-- Document Activities RLS
CREATE POLICY "Users can view document activities"
  ON public.documents_activities FOR SELECT
  USING (document_id IN (SELECT id FROM public.documents WHERE organization_id IN (SELECT organization_id FROM public.user_roles WHERE user_id = auth.uid() AND is_active = true)));

CREATE POLICY "Users can create document activities"
  ON public.documents_activities FOR INSERT
  WITH CHECK (document_id IN (SELECT id FROM public.documents WHERE organization_id IN (SELECT organization_id FROM public.user_roles WHERE user_id = auth.uid() AND is_active = true)));

-- Document Shares RLS
CREATE POLICY "Users can view shares in their organization"
  ON public.documents_shares FOR SELECT
  USING (organization_id IN (SELECT organization_id FROM public.user_roles WHERE user_id = auth.uid() AND is_active = true));

CREATE POLICY "Users can manage shares in their organization"
  ON public.documents_shares FOR ALL
  USING (organization_id IN (SELECT organization_id FROM public.user_roles WHERE user_id = auth.uid() AND is_active = true));

-- Public share access (for external viewing via token)
CREATE POLICY "Public can view shares by token"
  ON public.documents_shares FOR SELECT
  USING (true);

-- Workflow Actions RLS
CREATE POLICY "Users can view workflow actions in their organization"
  ON public.documents_workflow_actions FOR SELECT
  USING (organization_id IN (SELECT organization_id FROM public.user_roles WHERE user_id = auth.uid() AND is_active = true));

CREATE POLICY "Users can manage workflow actions in their organization"
  ON public.documents_workflow_actions FOR ALL
  USING (organization_id IN (SELECT organization_id FROM public.user_roles WHERE user_id = auth.uid() AND is_active = true));

-- Document Requests RLS
CREATE POLICY "Users can view document requests in their organization"
  ON public.documents_requests FOR SELECT
  USING (organization_id IN (SELECT organization_id FROM public.user_roles WHERE user_id = auth.uid() AND is_active = true));

CREATE POLICY "Users can manage document requests in their organization"
  ON public.documents_requests FOR ALL
  USING (organization_id IN (SELECT organization_id FROM public.user_roles WHERE user_id = auth.uid() AND is_active = true));

-- Document Versions RLS
CREATE POLICY "Users can view document versions"
  ON public.documents_versions FOR SELECT
  USING (document_id IN (SELECT id FROM public.documents WHERE organization_id IN (SELECT organization_id FROM public.user_roles WHERE user_id = auth.uid() AND is_active = true)));

CREATE POLICY "Users can create document versions"
  ON public.documents_versions FOR INSERT
  WITH CHECK (document_id IN (SELECT id FROM public.documents WHERE organization_id IN (SELECT organization_id FROM public.user_roles WHERE user_id = auth.uid() AND is_active = true)));

-- Document Comments RLS
CREATE POLICY "Users can view document comments"
  ON public.documents_comments FOR SELECT
  USING (document_id IN (SELECT id FROM public.documents WHERE organization_id IN (SELECT organization_id FROM public.user_roles WHERE user_id = auth.uid() AND is_active = true)));

CREATE POLICY "Users can manage document comments"
  ON public.documents_comments FOR ALL
  USING (document_id IN (SELECT id FROM public.documents WHERE organization_id IN (SELECT organization_id FROM public.user_roles WHERE user_id = auth.uid() AND is_active = true)));

-- Signature Templates RLS
CREATE POLICY "Users can view signature templates in their organization"
  ON public.signature_templates FOR SELECT
  USING (organization_id IN (SELECT organization_id FROM public.user_roles WHERE user_id = auth.uid() AND is_active = true));

CREATE POLICY "Users can manage signature templates in their organization"
  ON public.signature_templates FOR ALL
  USING (organization_id IN (SELECT organization_id FROM public.user_roles WHERE user_id = auth.uid() AND is_active = true));

-- Signature Requests RLS
CREATE POLICY "Users can view signature requests in their organization"
  ON public.signature_requests FOR SELECT
  USING (organization_id IN (SELECT organization_id FROM public.user_roles WHERE user_id = auth.uid() AND is_active = true));

CREATE POLICY "Users can manage signature requests in their organization"
  ON public.signature_requests FOR ALL
  USING (organization_id IN (SELECT organization_id FROM public.user_roles WHERE user_id = auth.uid() AND is_active = true));

-- Signature Signers RLS
CREATE POLICY "Users can view signers for their organization's requests"
  ON public.signature_signers FOR SELECT
  USING (request_id IN (SELECT id FROM public.signature_requests WHERE organization_id IN (SELECT organization_id FROM public.user_roles WHERE user_id = auth.uid() AND is_active = true)));

CREATE POLICY "Users can manage signers for their organization's requests"
  ON public.signature_signers FOR ALL
  USING (request_id IN (SELECT id FROM public.signature_requests WHERE organization_id IN (SELECT organization_id FROM public.user_roles WHERE user_id = auth.uid() AND is_active = true)));

-- Public signer access via token
CREATE POLICY "Signers can view their own record via token"
  ON public.signature_signers FOR SELECT
  USING (true);

-- Signature Fields RLS
CREATE POLICY "Users can view signature fields for their organization's requests"
  ON public.signature_fields FOR SELECT
  USING (request_id IN (SELECT id FROM public.signature_requests WHERE organization_id IN (SELECT organization_id FROM public.user_roles WHERE user_id = auth.uid() AND is_active = true)));

CREATE POLICY "Users can manage signature fields for their organization's requests"
  ON public.signature_fields FOR ALL
  USING (request_id IN (SELECT id FROM public.signature_requests WHERE organization_id IN (SELECT organization_id FROM public.user_roles WHERE user_id = auth.uid() AND is_active = true)));

-- Signature Audit Log RLS
CREATE POLICY "Users can view audit logs for their organization's requests"
  ON public.signature_audit_log FOR SELECT
  USING (request_id IN (SELECT id FROM public.signature_requests WHERE organization_id IN (SELECT organization_id FROM public.user_roles WHERE user_id = auth.uid() AND is_active = true)));

CREATE POLICY "System can create audit logs"
  ON public.signature_audit_log FOR INSERT
  WITH CHECK (true);

-- Spreadsheets RLS
CREATE POLICY "Users can view spreadsheets in their organization"
  ON public.spreadsheets FOR SELECT
  USING (organization_id IN (SELECT organization_id FROM public.user_roles WHERE user_id = auth.uid() AND is_active = true));

CREATE POLICY "Users can manage spreadsheets in their organization"
  ON public.spreadsheets FOR ALL
  USING (organization_id IN (SELECT organization_id FROM public.user_roles WHERE user_id = auth.uid() AND is_active = true));

-- Spreadsheet Sheets RLS
CREATE POLICY "Users can view sheets"
  ON public.spreadsheet_sheets FOR SELECT
  USING (spreadsheet_id IN (SELECT id FROM public.spreadsheets WHERE organization_id IN (SELECT organization_id FROM public.user_roles WHERE user_id = auth.uid() AND is_active = true)));

CREATE POLICY "Users can manage sheets"
  ON public.spreadsheet_sheets FOR ALL
  USING (spreadsheet_id IN (SELECT id FROM public.spreadsheets WHERE organization_id IN (SELECT organization_id FROM public.user_roles WHERE user_id = auth.uid() AND is_active = true)));

-- Spreadsheet Data Sources RLS
CREATE POLICY "Users can view data sources"
  ON public.spreadsheet_data_sources FOR SELECT
  USING (spreadsheet_id IN (SELECT id FROM public.spreadsheets WHERE organization_id IN (SELECT organization_id FROM public.user_roles WHERE user_id = auth.uid() AND is_active = true)));

CREATE POLICY "Users can manage data sources"
  ON public.spreadsheet_data_sources FOR ALL
  USING (spreadsheet_id IN (SELECT id FROM public.spreadsheets WHERE organization_id IN (SELECT organization_id FROM public.user_roles WHERE user_id = auth.uid() AND is_active = true)));

-- Dashboard Pins RLS
CREATE POLICY "Users can view their own dashboard pins"
  ON public.dashboard_spreadsheet_pins FOR SELECT
  USING (user_id = auth.uid());

CREATE POLICY "Users can manage their own dashboard pins"
  ON public.dashboard_spreadsheet_pins FOR ALL
  USING (user_id = auth.uid());