CREATE UNIQUE INDEX IF NOT EXISTS mf_clients_national_id_unique
  ON public.mf_clients (business_id, lower(btrim(national_id)))
  WHERE national_id IS NOT NULL AND btrim(national_id) <> '';