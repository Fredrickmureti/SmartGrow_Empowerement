-- Extend sms_event_type enum with new event types
ALTER TYPE public.sms_event_type ADD VALUE IF NOT EXISTS 'estimate_sent';
ALTER TYPE public.sms_event_type ADD VALUE IF NOT EXISTS 'delivery_shipped';
ALTER TYPE public.sms_event_type ADD VALUE IF NOT EXISTS 'payment_reminder';
ALTER TYPE public.sms_event_type ADD VALUE IF NOT EXISTS 'credit_note_issued';