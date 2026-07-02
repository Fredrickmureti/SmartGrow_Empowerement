
-- Attach the existing enforce_user_count_limit function as a trigger on user_roles
CREATE TRIGGER enforce_user_count_limit_trigger
  BEFORE INSERT ON public.user_roles
  FOR EACH ROW
  EXECUTE FUNCTION public.enforce_user_count_limit();

-- Attach the existing enforce_invoice_count_limit function as a trigger on invoices
CREATE TRIGGER enforce_invoice_count_limit_trigger
  BEFORE INSERT ON public.invoices
  FOR EACH ROW
  EXECUTE FUNCTION public.enforce_invoice_count_limit();
