-- Prevent unpublish/deactivate of a localization pack while installations exist.
CREATE OR REPLACE FUNCTION public.localization_packs_block_lifecycle_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_count integer;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    -- Only intercept transitions that would hide the pack from tenants.
    IF (OLD.is_published = true AND NEW.is_published = false)
       OR (COALESCE(OLD.is_active, true) = true AND COALESCE(NEW.is_active, true) = false) THEN
      SELECT count(*) INTO v_count
      FROM public.installed_localization_packs
      WHERE pack_id = OLD.id;
      IF v_count > 0 THEN
        RAISE EXCEPTION
          'Cannot unpublish or deactivate pack % while % installation(s) reference it. Uninstall first.',
          OLD.id, v_count
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
    RETURN NEW;
  ELSIF TG_OP = 'DELETE' THEN
    SELECT count(*) INTO v_count
    FROM public.installed_localization_packs
    WHERE pack_id = OLD.id;
    IF v_count > 0 THEN
      RAISE EXCEPTION
        'Cannot delete pack % while % installation(s) reference it.',
        OLD.id, v_count
        USING ERRCODE = 'foreign_key_violation';
    END IF;
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_localization_packs_block_lifecycle ON public.localization_packs;
CREATE TRIGGER trg_localization_packs_block_lifecycle
BEFORE UPDATE OR DELETE ON public.localization_packs
FOR EACH ROW EXECUTE FUNCTION public.localization_packs_block_lifecycle_change();

-- Mirror protection on pack_versions: a version cannot leave 'published'
-- status while any install pins that pack_version string.
CREATE OR REPLACE FUNCTION public.pack_versions_block_lifecycle_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_count integer;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF OLD.status = 'published' AND NEW.status <> 'published' THEN
      SELECT count(*) INTO v_count
      FROM public.installed_localization_packs i
      WHERE i.pack_id = OLD.pack_id
        AND i.pack_version = OLD.version;
      IF v_count > 0 THEN
        RAISE EXCEPTION
          'Cannot move pack_version %/% out of published while % installation(s) pin it.',
          OLD.pack_id, OLD.version, v_count
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
    RETURN NEW;
  ELSIF TG_OP = 'DELETE' THEN
    SELECT count(*) INTO v_count
    FROM public.installed_localization_packs i
    WHERE i.pack_id = OLD.pack_id
      AND i.pack_version = OLD.version;
    IF v_count > 0 THEN
      RAISE EXCEPTION
        'Cannot delete pack_version %/% while % installation(s) pin it.',
        OLD.pack_id, OLD.version, v_count
        USING ERRCODE = 'foreign_key_violation';
    END IF;
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_pack_versions_block_lifecycle ON public.pack_versions;
CREATE TRIGGER trg_pack_versions_block_lifecycle
BEFORE UPDATE OR DELETE ON public.pack_versions
FOR EACH ROW EXECUTE FUNCTION public.pack_versions_block_lifecycle_change();