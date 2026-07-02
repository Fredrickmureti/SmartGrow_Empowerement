
ALTER TABLE public.printer_profiles
  ADD COLUMN IF NOT EXISTS columns_override int,
  ADD COLUMN IF NOT EXISTS margin_cols int,
  ADD COLUMN IF NOT EXISTS font text NOT NULL DEFAULT 'A',
  ADD COLUMN IF NOT EXISTS cutter text NOT NULL DEFAULT 'full',
  ADD COLUMN IF NOT EXISTS qr_native boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS code128_native boolean NOT NULL DEFAULT true;

ALTER TABLE public.printer_profiles
  DROP CONSTRAINT IF EXISTS printer_profiles_paper_format_check;

ALTER TABLE public.printer_profiles
  ADD CONSTRAINT printer_profiles_paper_format_check
    CHECK (paper_format = ANY (ARRAY['a4'::text,'letter'::text,'a5'::text,'80mm'::text,'58mm'::text,'40mm'::text,'custom'::text]));

ALTER TABLE public.printer_profiles
  ADD CONSTRAINT printer_profiles_font_check
    CHECK (font IN ('A','B'));

ALTER TABLE public.printer_profiles
  ADD CONSTRAINT printer_profiles_cutter_check
    CHECK (cutter IN ('none','partial','full'));

ALTER TABLE public.printer_profiles
  ADD CONSTRAINT printer_profiles_columns_override_range
    CHECK (columns_override IS NULL OR (columns_override BETWEEN 16 AND 96));

ALTER TABLE public.printer_profiles
  ADD CONSTRAINT printer_profiles_margin_cols_range
    CHECK (margin_cols IS NULL OR (margin_cols BETWEEN 0 AND 6));
