-- Invoice Activities Table for tracking all invoice events
CREATE TABLE public.invoice_activities (
    id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
    invoice_id UUID NOT NULL REFERENCES public.invoices(id) ON DELETE CASCADE,
    organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
    action TEXT NOT NULL,
    details JSONB DEFAULT '{}',
    performed_by UUID REFERENCES auth.users(id),
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Invoice Reminders Table for scheduling payment reminders
CREATE TABLE public.invoice_reminders (
    id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
    invoice_id UUID NOT NULL REFERENCES public.invoices(id) ON DELETE CASCADE,
    organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
    reminder_type TEXT NOT NULL DEFAULT 'email',
    scheduled_at TIMESTAMP WITH TIME ZONE NOT NULL,
    sent_at TIMESTAMP WITH TIME ZONE,
    status TEXT NOT NULL DEFAULT 'pending',
    created_by UUID REFERENCES auth.users(id),
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Invoice Email History
CREATE TABLE public.invoice_emails (
    id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
    invoice_id UUID NOT NULL REFERENCES public.invoices(id) ON DELETE CASCADE,
    organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
    recipient_email TEXT NOT NULL,
    subject TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'sent',
    sent_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
    sent_by UUID REFERENCES auth.users(id),
    error_message TEXT
);

-- Enable RLS
ALTER TABLE public.invoice_activities ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.invoice_reminders ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.invoice_emails ENABLE ROW LEVEL SECURITY;

-- RLS Policies for invoice_activities
CREATE POLICY "Users can view invoice activities in their org"
    ON public.invoice_activities FOR SELECT
    USING (public.is_org_member(auth.uid(), organization_id));

CREATE POLICY "Users can create invoice activities in their org"
    ON public.invoice_activities FOR INSERT
    WITH CHECK (public.is_org_member(auth.uid(), organization_id));

-- RLS Policies for invoice_reminders
CREATE POLICY "Users can view invoice reminders in their org"
    ON public.invoice_reminders FOR SELECT
    USING (public.is_org_member(auth.uid(), organization_id));

CREATE POLICY "Users can manage invoice reminders in their org"
    ON public.invoice_reminders FOR ALL
    USING (public.is_org_member(auth.uid(), organization_id));

-- RLS Policies for invoice_emails
CREATE POLICY "Users can view invoice emails in their org"
    ON public.invoice_emails FOR SELECT
    USING (public.is_org_member(auth.uid(), organization_id));

CREATE POLICY "Users can create invoice emails in their org"
    ON public.invoice_emails FOR INSERT
    WITH CHECK (public.is_org_member(auth.uid(), organization_id));

-- Add indexes for performance
CREATE INDEX idx_invoice_activities_invoice ON public.invoice_activities(invoice_id);
CREATE INDEX idx_invoice_activities_org ON public.invoice_activities(organization_id);
CREATE INDEX idx_invoice_reminders_invoice ON public.invoice_reminders(invoice_id);
CREATE INDEX idx_invoice_reminders_scheduled ON public.invoice_reminders(scheduled_at) WHERE status = 'pending';
CREATE INDEX idx_invoice_emails_invoice ON public.invoice_emails(invoice_id);

-- Add sent_at column to invoices for tracking when email was sent
ALTER TABLE public.invoices ADD COLUMN IF NOT EXISTS sent_at TIMESTAMP WITH TIME ZONE;
ALTER TABLE public.invoices ADD COLUMN IF NOT EXISTS last_reminder_at TIMESTAMP WITH TIME ZONE;