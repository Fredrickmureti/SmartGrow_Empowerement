-- Phase B.2 — structured ReceiptTheme storage. Adds nullable jsonb columns
-- alongside the existing flat receipt_settings; the read-time resolver
-- prefers theme when present. No backfill (read-path migrator handles it).

ALTER TABLE public.businesses
  ADD COLUMN IF NOT EXISTS receipt_theme jsonb,
  ADD COLUMN IF NOT EXISTS receipt_engine_v2 boolean NOT NULL DEFAULT false;

ALTER TABLE public.pos_registers
  ADD COLUMN IF NOT EXISTS receipt_theme jsonb,
  ADD COLUMN IF NOT EXISTS printer_profile jsonb;

COMMENT ON COLUMN public.businesses.receipt_theme IS
  'Phase B receipt model — structured ReceiptTheme. When NULL, read path falls back to flatToTheme(receipt_settings).';

COMMENT ON COLUMN public.businesses.receipt_engine_v2 IS
  'When true, the renderer uses the v2 (theme-driven) engine path. Default false during the migration window.';

COMMENT ON COLUMN public.pos_registers.receipt_theme IS
  'Per-register override of the business receipt_theme. Resolver precedence: register → branch → business → flat fallback.';

COMMENT ON COLUMN public.pos_registers.printer_profile IS
  'Per-register printer capability + paper override (paper, font, columns, margin, caps). Consumed by resolvePrinterProfile().';
