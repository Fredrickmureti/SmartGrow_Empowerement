
-- P3.3: Add SMS consent column to contacts
ALTER TABLE public.contacts ADD COLUMN IF NOT EXISTS sms_consent boolean DEFAULT true;

-- Add comment for documentation
COMMENT ON COLUMN public.contacts.sms_consent IS 'Whether the contact has consented to receive SMS notifications. Defaults to true (opt-out model).';
