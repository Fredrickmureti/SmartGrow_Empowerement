CREATE TABLE IF NOT EXISTS public.printer_profiles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
  label text NOT NULL,
  transport text NOT NULL CHECK (transport IN ('electron','local_agent','web_usb','network','browser')),
  address text,
  paper_format text NOT NULL DEFAULT 'a4' CHECK (paper_format IN ('a4','letter','a5','80mm','58mm')),
  escpos_codepage text,
  is_active boolean NOT NULL DEFAULT true,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS printer_profiles_business_idx
  ON public.printer_profiles (business_id) WHERE is_active;

COMMENT ON TABLE public.printer_profiles IS
  'Stage W7 (ADR-0008): named physical printers per business. Referenced by document_print_policies.printer_profile_id to route auto_print to a specific device.';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'document_print_policies_printer_profile_id_fkey'
      AND table_name = 'document_print_policies'
  ) THEN
    ALTER TABLE public.document_print_policies
      ADD CONSTRAINT document_print_policies_printer_profile_id_fkey
      FOREIGN KEY (printer_profile_id)
      REFERENCES public.printer_profiles(id)
      ON DELETE SET NULL;
  END IF;
END $$;

DROP TRIGGER IF EXISTS update_printer_profiles_updated_at ON public.printer_profiles;
CREATE TRIGGER update_printer_profiles_updated_at
BEFORE UPDATE ON public.printer_profiles
FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

ALTER TABLE public.printer_profiles ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Members can view printer profiles" ON public.printer_profiles;
CREATE POLICY "Members can view printer profiles"
ON public.printer_profiles FOR SELECT
TO authenticated
USING (
  EXISTS (
    SELECT 1 FROM public.businesses b
    WHERE b.id = printer_profiles.business_id
      AND public.is_org_member(auth.uid(), b.organization_id)
  )
);

DROP POLICY IF EXISTS "Admins can manage printer profiles" ON public.printer_profiles;
CREATE POLICY "Admins can manage printer profiles"
ON public.printer_profiles FOR ALL
TO authenticated
USING (
  EXISTS (
    SELECT 1 FROM public.businesses b
    WHERE b.id = printer_profiles.business_id
      AND public.has_any_org_role(auth.uid(), b.organization_id, ARRAY['owner','admin','accountant']::app_role[])
  )
)
WITH CHECK (
  EXISTS (
    SELECT 1 FROM public.businesses b
    WHERE b.id = printer_profiles.business_id
      AND public.has_any_org_role(auth.uid(), b.organization_id, ARRAY['owner','admin','accountant']::app_role[])
  )
);