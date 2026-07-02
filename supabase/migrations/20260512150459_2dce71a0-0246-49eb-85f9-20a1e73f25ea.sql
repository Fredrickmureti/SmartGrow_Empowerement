
ALTER TABLE public.pos_registers
  ADD COLUMN IF NOT EXISTS printer_capabilities jsonb NOT NULL
    DEFAULT '{"auto_cut": true, "partial_cut": true, "qr_native": true, "code128_native": true}'::jsonb;

COMMENT ON COLUMN public.pos_registers.printer_capabilities IS
  'Capability profile for the connected thermal printer. Builder downgrades unsupported features (e.g. emits a printed URL when qr_native is false). Keys: auto_cut, partial_cut, qr_native, code128_native, columns_override (number, optional).';
