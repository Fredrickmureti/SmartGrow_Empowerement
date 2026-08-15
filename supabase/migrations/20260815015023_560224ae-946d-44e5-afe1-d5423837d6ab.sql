COMMENT ON FUNCTION public.build_invoice_je_lines(uuid) IS 'Phase 6.1: server-authoritative invoice journal lines (AR, per-product revenue, output tax, discount).';
NOTIFY pgrst, 'reload schema';