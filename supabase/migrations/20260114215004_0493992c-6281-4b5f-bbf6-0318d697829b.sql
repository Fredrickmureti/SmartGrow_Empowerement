-- Create document_emails table to log all document emails
CREATE TABLE public.document_emails (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  document_type TEXT NOT NULL CHECK (document_type IN ('invoice', 'estimate', 'proforma', 'credit_note', 'delivery_note')),
  document_id UUID NOT NULL,
  recipient_email TEXT NOT NULL,
  cc_emails TEXT[],
  bcc_emails TEXT[],
  subject TEXT NOT NULL,
  message TEXT,
  status TEXT NOT NULL DEFAULT 'sent' CHECK (status IN ('sent', 'failed', 'pending')),
  had_attachment BOOLEAN DEFAULT FALSE,
  attachment_filename TEXT,
  sent_at TIMESTAMPTZ DEFAULT NOW(),
  sent_by UUID REFERENCES auth.users(id),
  error_message TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Enable Row Level Security
ALTER TABLE public.document_emails ENABLE ROW LEVEL SECURITY;

-- Create policies for document_emails
CREATE POLICY "Users can view document emails for their organization"
ON public.document_emails
FOR SELECT
USING (organization_id IN (SELECT public.get_user_organizations(auth.uid())));

CREATE POLICY "Users can insert document emails for their organization"
ON public.document_emails
FOR INSERT
WITH CHECK (organization_id IN (SELECT public.get_user_organizations(auth.uid())));

-- Create index for faster queries
CREATE INDEX idx_document_emails_org_id ON public.document_emails(organization_id);
CREATE INDEX idx_document_emails_document ON public.document_emails(document_type, document_id);
CREATE INDEX idx_document_emails_sent_at ON public.document_emails(sent_at DESC);