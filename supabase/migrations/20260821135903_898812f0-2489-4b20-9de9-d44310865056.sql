COMMENT ON FUNCTION public.apply_credit_to_invoice_atomic(uuid, uuid, uuid, uuid, numeric, uuid, text, uuid)
  IS 'Applies customer credit to an invoice. Each leg is relieved at its own booking rate; the difference is realised FX (ADR 0136).';

NOTIFY pgrst, 'reload schema';