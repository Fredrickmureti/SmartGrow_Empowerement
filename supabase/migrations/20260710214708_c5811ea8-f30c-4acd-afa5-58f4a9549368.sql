ALTER TABLE public.localization_pack_binary_assets
  ALTER COLUMN bytes DROP NOT NULL,
  ADD COLUMN IF NOT EXISTS source_url text,
  ADD CONSTRAINT localization_pack_binary_assets_bytes_or_url_chk
    CHECK (bytes IS NOT NULL OR source_url IS NOT NULL);