-- =========================================================================
-- SCHEMA MIGRATION A — ADDITIVE (Odoo alignment) — final v2
-- =========================================================================

-- ----- 1. Per-company configuration columns on businesses -----
ALTER TABLE public.businesses
  ADD COLUMN IF NOT EXISTS fiscal_year_start integer,
  ADD COLUMN IF NOT EXISTS timezone text,
  ADD COLUMN IF NOT EXISTS date_format text,
  ADD COLUMN IF NOT EXISTS number_format text,
  ADD COLUMN IF NOT EXISTS default_payment_terms integer,
  ADD COLUMN IF NOT EXISTS default_tax_rate_id uuid,
  ADD COLUMN IF NOT EXISTS email_display_name text,
  ADD COLUMN IF NOT EXISTS email_reply_to text,
  ADD COLUMN IF NOT EXISTS industry text,
  ADD COLUMN IF NOT EXISTS business_type text,
  ADD COLUMN IF NOT EXISTS setup_wizard_completed boolean DEFAULT false,
  ADD COLUMN IF NOT EXISTS setup_wizard_step integer DEFAULT 0,
  ADD COLUMN IF NOT EXISTS sample_data_prompt_dismissed boolean DEFAULT false,
  ADD COLUMN IF NOT EXISTS archived_at timestamptz;

-- Backfill from parent organization
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='organizations' AND column_name='fiscal_year_start') THEN
    EXECUTE 'UPDATE public.businesses b SET fiscal_year_start = o.fiscal_year_start FROM public.organizations o WHERE b.organization_id = o.id AND b.fiscal_year_start IS NULL AND o.fiscal_year_start IS NOT NULL';
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='organizations' AND column_name='timezone') THEN
    EXECUTE 'UPDATE public.businesses b SET timezone = o.timezone FROM public.organizations o WHERE b.organization_id = o.id AND b.timezone IS NULL AND o.timezone IS NOT NULL';
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='organizations' AND column_name='date_format') THEN
    EXECUTE 'UPDATE public.businesses b SET date_format = o.date_format FROM public.organizations o WHERE b.organization_id = o.id AND b.date_format IS NULL AND o.date_format IS NOT NULL';
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='organizations' AND column_name='number_format') THEN
    EXECUTE 'UPDATE public.businesses b SET number_format = o.number_format FROM public.organizations o WHERE b.organization_id = o.id AND b.number_format IS NULL AND o.number_format IS NOT NULL';
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='organizations' AND column_name='default_payment_terms') THEN
    EXECUTE 'UPDATE public.businesses b SET default_payment_terms = o.default_payment_terms FROM public.organizations o WHERE b.organization_id = o.id AND b.default_payment_terms IS NULL AND o.default_payment_terms IS NOT NULL';
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='organizations' AND column_name='default_tax_rate_id') THEN
    EXECUTE 'UPDATE public.businesses b SET default_tax_rate_id = o.default_tax_rate_id FROM public.organizations o WHERE b.organization_id = o.id AND b.default_tax_rate_id IS NULL AND o.default_tax_rate_id IS NOT NULL';
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='organizations' AND column_name='email_display_name') THEN
    EXECUTE 'UPDATE public.businesses b SET email_display_name = o.email_display_name FROM public.organizations o WHERE b.organization_id = o.id AND b.email_display_name IS NULL AND o.email_display_name IS NOT NULL';
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='organizations' AND column_name='email_reply_to') THEN
    EXECUTE 'UPDATE public.businesses b SET email_reply_to = o.email_reply_to FROM public.organizations o WHERE b.organization_id = o.id AND b.email_reply_to IS NULL AND o.email_reply_to IS NOT NULL';
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='organizations' AND column_name='industry') THEN
    EXECUTE 'UPDATE public.businesses b SET industry = o.industry::text FROM public.organizations o WHERE b.organization_id = o.id AND b.industry IS NULL AND o.industry IS NOT NULL';
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='organizations' AND column_name='business_type') THEN
    EXECUTE 'UPDATE public.businesses b SET business_type = o.business_type::text FROM public.organizations o WHERE b.organization_id = o.id AND b.business_type IS NULL AND o.business_type IS NOT NULL';
  END IF;
END $$;

-- ----- 2. Clean up duplicate HQ branches -----
WITH ranked AS (
  SELECT id, business_id,
         ROW_NUMBER() OVER (PARTITION BY business_id ORDER BY created_at ASC, id ASC) AS rn
  FROM public.branches
  WHERE is_headquarters = true
)
UPDATE public.branches
SET is_headquarters = false
WHERE id IN (SELECT id FROM ranked WHERE rn > 1);

CREATE UNIQUE INDEX IF NOT EXISTS idx_branches_one_hq_per_business
  ON public.branches (business_id)
  WHERE is_headquarters = true;

-- ----- 3. Extend user_business_access -----
ALTER TABLE public.user_business_access
  ADD COLUMN IF NOT EXISTS role text NOT NULL DEFAULT 'staff',
  ADD COLUMN IF NOT EXISTS can_post boolean NOT NULL DEFAULT false;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'user_business_access_user_business_unique'
  ) THEN
    BEGIN
      ALTER TABLE public.user_business_access
        ADD CONSTRAINT user_business_access_user_business_unique UNIQUE (user_id, business_id);
    EXCEPTION WHEN unique_violation THEN
      -- duplicates exist; deduplicate keeping oldest
      DELETE FROM public.user_business_access a
      USING public.user_business_access b
      WHERE a.user_id = b.user_id AND a.business_id = b.business_id AND a.created_at > b.created_at;
      ALTER TABLE public.user_business_access
        ADD CONSTRAINT user_business_access_user_business_unique UNIQUE (user_id, business_id);
    END;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_uba_user ON public.user_business_access(user_id);
CREATE INDEX IF NOT EXISTS idx_uba_business ON public.user_business_access(business_id);

ALTER TABLE public.user_business_access ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can read their own business access" ON public.user_business_access;
CREATE POLICY "Users can read their own business access"
  ON public.user_business_access FOR SELECT
  USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Workspace owners manage business access" ON public.user_business_access;
CREATE POLICY "Workspace owners manage business access"
  ON public.user_business_access FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM public.businesses b
      JOIN public.organizations o ON o.id = b.organization_id
      WHERE b.id = user_business_access.business_id
        AND o.owner_user_id = auth.uid()
    )
    OR EXISTS (
      SELECT 1 FROM public.user_roles ur
      WHERE ur.user_id = auth.uid() AND ur.role = 'super_admin'::app_role
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.businesses b
      JOIN public.organizations o ON o.id = b.organization_id
      WHERE b.id = user_business_access.business_id
        AND o.owner_user_id = auth.uid()
    )
    OR EXISTS (
      SELECT 1 FROM public.user_roles ur
      WHERE ur.user_id = auth.uid() AND ur.role = 'super_admin'::app_role
    )
  );

-- Backfill from user_roles: every active org membership grants access to every business in that org
INSERT INTO public.user_business_access (user_id, organization_id, business_id, role, can_post, is_primary, can_switch)
SELECT DISTINCT ur.user_id, b.organization_id, b.id,
       ur.role::text,
       CASE WHEN ur.role::text IN ('super_admin','owner','admin','accountant') THEN true ELSE false END,
       false, true
FROM public.user_roles ur
JOIN public.businesses b ON b.organization_id = ur.organization_id
WHERE ur.is_active = true AND ur.organization_id IS NOT NULL
ON CONFLICT (user_id, business_id) DO NOTHING;

-- ----- 4. user_active_business -----
CREATE TABLE IF NOT EXISTS public.user_active_business (
  user_id uuid PRIMARY KEY,
  business_id uuid NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.user_active_business ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users manage their own active business" ON public.user_active_business;
CREATE POLICY "Users manage their own active business"
  ON public.user_active_business FOR ALL
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

INSERT INTO public.user_active_business (user_id, business_id)
SELECT DISTINCT ON (uba.user_id) uba.user_id, uba.business_id
FROM public.user_business_access uba
ORDER BY uba.user_id, uba.created_at ASC
ON CONFLICT (user_id) DO NOTHING;

-- ----- 5. Guard trigger: prevent archiving with open balances -----
CREATE OR REPLACE FUNCTION public.guard_business_archive()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  open_invoices integer := 0;
  open_bills integer := 0;
  open_jes integer := 0;
BEGIN
  IF NEW.archived_at IS NOT NULL AND OLD.archived_at IS NULL THEN
    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='invoices' AND column_name='business_id') THEN
      EXECUTE 'SELECT COUNT(*) FROM public.invoices WHERE business_id = $1 AND status NOT IN (''paid'',''cancelled'',''void'')'
        INTO open_invoices USING NEW.id;
    END IF;
    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='bills' AND column_name='business_id') THEN
      EXECUTE 'SELECT COUNT(*) FROM public.bills WHERE business_id = $1 AND status NOT IN (''paid'',''cancelled'',''void'')'
        INTO open_bills USING NEW.id;
    END IF;
    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='journal_entries' AND column_name='business_id') THEN
      EXECUTE 'SELECT COUNT(*) FROM public.journal_entries WHERE business_id = $1 AND status = ''draft'''
        INTO open_jes USING NEW.id;
    END IF;

    IF open_invoices > 0 OR open_bills > 0 OR open_jes > 0 THEN
      RAISE EXCEPTION 'Cannot archive business %: % open invoice(s), % open bill(s), % draft journal(s). Resolve them first.',
        NEW.name, open_invoices, open_bills, open_jes
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_guard_business_archive ON public.businesses;
CREATE TRIGGER trg_guard_business_archive
  BEFORE UPDATE OF archived_at ON public.businesses
  FOR EACH ROW
  EXECUTE FUNCTION public.guard_business_archive();

-- ----- 6. updated_at trigger -----
DROP TRIGGER IF EXISTS trg_uab_updated_at ON public.user_active_business;
CREATE TRIGGER trg_uab_updated_at
  BEFORE UPDATE ON public.user_active_business
  FOR EACH ROW
  EXECUTE FUNCTION public.update_updated_at_column();