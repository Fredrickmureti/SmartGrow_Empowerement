-- Retire (delete, not deprecate) the legacy integer company payment-terms column.
-- Payment terms are resolved exclusively via public.resolve_payment_term
-- (document override -> party default -> company default payment_terms row -> due on receipt).
-- Recreate the settings audit trigger without the retired column first.
DROP TRIGGER IF EXISTS audit_businesses_settings ON public.businesses;
CREATE TRIGGER audit_businesses_settings
  AFTER UPDATE ON public.businesses
  FOR EACH ROW
  EXECUTE FUNCTION public.audit_settings_change(
    'business',
    'name,legal_name,tax_id,registration_number,address,phone,email,base_currency,fiscal_year_start,timezone,logo_url,invoice_prefix,estimate_prefix,bill_prefix,receipt_settings,default_tax_rate_id,email_display_name,email_reply_to'
  );

ALTER TABLE public.businesses DROP COLUMN IF EXISTS default_payment_terms;