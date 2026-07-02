
-- Extend sms_event_type enum with new event types for full ERP coverage
ALTER TYPE public.sms_event_type ADD VALUE IF NOT EXISTS 'sales_order_confirmed';
ALTER TYPE public.sms_event_type ADD VALUE IF NOT EXISTS 'recurring_invoice_generated';
ALTER TYPE public.sms_event_type ADD VALUE IF NOT EXISTS 'expense_approved';
ALTER TYPE public.sms_event_type ADD VALUE IF NOT EXISTS 'expense_rejected';
ALTER TYPE public.sms_event_type ADD VALUE IF NOT EXISTS 'payroll_processed';
ALTER TYPE public.sms_event_type ADD VALUE IF NOT EXISTS 'low_stock_alert';
ALTER TYPE public.sms_event_type ADD VALUE IF NOT EXISTS 'customer_statement_sent';

-- Add 'employee' to sms_recipient_type for internal notifications
ALTER TYPE public.sms_recipient_type ADD VALUE IF NOT EXISTS 'employee';
ALTER TYPE public.sms_recipient_type ADD VALUE IF NOT EXISTS 'internal';
