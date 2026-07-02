
-- =====================================================================
-- COA HEADERS: first-class concept + postability/mapping protection
-- =====================================================================

-- 1. Schema --------------------------------------------------------------
ALTER TABLE public.accounts
  ADD COLUMN IF NOT EXISTS is_header boolean NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS idx_accounts_is_header
  ON public.accounts (organization_id, is_header)
  WHERE is_header = true;

-- 2. Backfill: any account that has children is a header ----------------
UPDATE public.accounts a
SET is_header = true
WHERE EXISTS (
  SELECT 1 FROM public.accounts c WHERE c.parent_id = a.id
)
AND is_header = false;

-- 3. Headers must not carry a leaf-level detail_type --------------------
UPDATE public.accounts
SET detail_type = NULL
WHERE is_header = true
  AND detail_type IS NOT NULL;

-- 4. Auto-create leaf children where the header used to carry meaning ---
-- For each broken header that previously held a leaf detail_type AND has
-- no child of the same parent already covering that detail_type, create a
-- proper leaf child. We re-derive the lost detail_type from the audit
-- trail in default_account_settings: if any role currently points to the
-- header AND the role's eligibility includes a single high-priority
-- detail_type matching the header's account_type, create that leaf.
DO $repair$
DECLARE
  hdr RECORD;
  next_code text;
  new_id uuid;
  target_detail text;
  target_label text;
BEGIN
  FOR hdr IN
    SELECT a.id, a.organization_id, a.business_id, a.account_type, a.code, a.name, a.parent_id
    FROM public.accounts a
    WHERE a.is_header = true
      AND a.is_system = true
      AND EXISTS (
        SELECT 1 FROM public.default_account_settings d
        WHERE d.account_id = a.id
      )
  LOOP
    -- Find the role currently (mis)pointing to this header, then the
    -- preferred detail_type for that role for this account_type.
    SELECT e.detail_type,
           sar.label
      INTO target_detail, target_label
    FROM public.default_account_settings d
    JOIN public.account_role_eligibility e
      ON e.role_key = d.setting_key
     AND e.account_type = hdr.account_type
    JOIN public.system_account_roles sar
      ON sar.role_key = d.setting_key
    WHERE d.account_id = hdr.id
    ORDER BY e.priority ASC
    LIMIT 1;

    IF target_detail IS NULL THEN
      CONTINUE;
    END IF;

    -- Skip if a sibling already covers this detail_type
    IF EXISTS (
      SELECT 1 FROM public.accounts s
      WHERE s.parent_id = hdr.id
        AND s.detail_type = target_detail
        AND s.is_header = false
    ) THEN
      CONTINUE;
    END IF;

    -- Compute the next free code under this header
    SELECT (MAX(CAST(NULLIF(regexp_replace(code, '[^0-9]', '', 'g'), '') AS bigint)) + 10)::text
      INTO next_code
    FROM public.accounts
    WHERE parent_id = hdr.id
      AND code ~ '^[0-9]+$';

    IF next_code IS NULL THEN
      next_code := (CAST(hdr.code AS bigint) + 10)::text;
    END IF;

    -- Avoid collision
    WHILE EXISTS (
      SELECT 1 FROM public.accounts
      WHERE organization_id = hdr.organization_id
        AND code = next_code
    ) LOOP
      next_code := (CAST(next_code AS bigint) + 10)::text;
    END LOOP;

    INSERT INTO public.accounts (
      organization_id, business_id, account_type, code, name,
      description, parent_id, is_system, is_active, is_header, detail_type
    ) VALUES (
      hdr.organization_id, hdr.business_id, hdr.account_type, next_code,
      COALESCE(target_label, initcap(replace(target_detail, '_', ' '))),
      'Auto-created leaf for ' || hdr.name || ' (was incorrectly stored on the header)',
      hdr.id, true, true, false, target_detail
    ) RETURNING id INTO new_id;

    -- Re-point any default_account_settings rows from the header to the
    -- new leaf, but only where the new leaf's detail_type is eligible.
    UPDATE public.default_account_settings d
    SET account_id = new_id, updated_at = now()
    WHERE d.account_id = hdr.id
      AND EXISTS (
        SELECT 1 FROM public.account_role_eligibility e
        WHERE e.role_key = d.setting_key
          AND e.account_type = hdr.account_type
          AND e.detail_type = target_detail
      );
  END LOOP;
END;
$repair$;

-- 5. Nuke any default_account_settings rows still pointing at a header --
-- (these are cases where we couldn't infer a target leaf — surface them
-- as unmapped so the user re-picks via the proper UI / Apply Defaults.)
DELETE FROM public.default_account_settings d
USING public.accounts a
WHERE d.account_id = a.id
  AND a.is_header = true;

-- 6. Trigger: prevent leaf detail_type on a header ----------------------
CREATE OR REPLACE FUNCTION public.enforce_header_no_detail_type()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.is_header = true AND NEW.detail_type IS NOT NULL THEN
    RAISE EXCEPTION
      'Header account %/% cannot carry a detail_type (got %). Headers are non-postable group accounts.',
      NEW.code, NEW.name, NEW.detail_type
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_enforce_header_no_detail_type ON public.accounts;
CREATE TRIGGER trg_enforce_header_no_detail_type
  BEFORE INSERT OR UPDATE OF is_header, detail_type ON public.accounts
  FOR EACH ROW
  EXECUTE FUNCTION public.enforce_header_no_detail_type();

-- 7. Trigger: block journal lines posting to a header -------------------
CREATE OR REPLACE FUNCTION public.prevent_journal_post_to_header()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  hdr boolean;
  acode text;
  aname text;
BEGIN
  SELECT is_header, code, name
    INTO hdr, acode, aname
  FROM public.accounts
  WHERE id = NEW.account_id;

  IF hdr IS TRUE THEN
    RAISE EXCEPTION
      'Cannot post to header account %/%. Header (group) accounts are non-postable; pick a leaf child.',
      acode, aname
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_prevent_journal_post_to_header ON public.journal_entry_lines;
CREATE TRIGGER trg_prevent_journal_post_to_header
  BEFORE INSERT OR UPDATE OF account_id ON public.journal_entry_lines
  FOR EACH ROW
  EXECUTE FUNCTION public.prevent_journal_post_to_header();

-- 8. Extend default_account_settings validation to reject headers -------
-- Wrap (don't replace) by adding a header guard trigger that fires
-- BEFORE the existing eligibility validator. Using a separate trigger
-- keeps the existing validate_default_account_setting untouched.
CREATE OR REPLACE FUNCTION public.reject_header_in_default_mapping()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  hdr boolean;
  acode text;
  aname text;
BEGIN
  SELECT is_header, code, name
    INTO hdr, acode, aname
  FROM public.accounts
  WHERE id = NEW.account_id;

  IF hdr IS TRUE THEN
    RAISE EXCEPTION
      'Cannot map role "%": account %/% is a header (group) account and is not postable. Pick a leaf child instead.',
      NEW.setting_key, acode, aname
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_reject_header_in_default_mapping ON public.default_account_settings;
CREATE TRIGGER trg_reject_header_in_default_mapping
  BEFORE INSERT OR UPDATE OF account_id ON public.default_account_settings
  FOR EACH ROW
  EXECUTE FUNCTION public.reject_header_in_default_mapping();
