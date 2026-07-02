
-- ============================================================
-- P0-1: Posted Journal Entry Immutability Enforcement
-- ============================================================

-- Trigger: Prevent UPDATE on core fields of posted/voided journal_entries
-- Allowed transitions: posted → voided (only status, voided_at, voided_by, void_reason, updated_at)
CREATE OR REPLACE FUNCTION public.enforce_journal_entry_immutability()
RETURNS TRIGGER AS $$
BEGIN
  -- Only enforce on posted or voided entries
  IF OLD.status NOT IN ('posted', 'voided') THEN
    RETURN NEW;
  END IF;

  -- Allow posted → voided transition
  IF OLD.status = 'posted' AND NEW.status = 'voided' THEN
    -- Only allow status, voided_at, voided_by, void_reason, updated_at to change
    IF NEW.entry_date IS DISTINCT FROM OLD.entry_date
       OR NEW.description IS DISTINCT FROM OLD.description
       OR NEW.reference IS DISTINCT FROM OLD.reference
       OR NEW.entry_number IS DISTINCT FROM OLD.entry_number
       OR NEW.source_type IS DISTINCT FROM OLD.source_type
       OR NEW.source_id IS DISTINCT FROM OLD.source_id
       OR NEW.is_adjusting IS DISTINCT FROM OLD.is_adjusting
       OR NEW.is_closing IS DISTINCT FROM OLD.is_closing
       OR NEW.is_reversing IS DISTINCT FROM OLD.is_reversing
       OR NEW.reversed_entry_id IS DISTINCT FROM OLD.reversed_entry_id
       OR NEW.posted_at IS DISTINCT FROM OLD.posted_at
       OR NEW.posted_by IS DISTINCT FROM OLD.posted_by
    THEN
      RAISE EXCEPTION 'Cannot modify core fields of a posted journal entry. Only voiding is allowed.';
    END IF;
    RETURN NEW;
  END IF;

  -- Voided entries cannot be changed at all
  IF OLD.status = 'voided' THEN
    RAISE EXCEPTION 'Cannot modify a voided journal entry.';
  END IF;

  -- Posted entries: block any other update (e.g. posted → posted with field changes)
  RAISE EXCEPTION 'Cannot modify a posted journal entry. Create a reversing entry or void it instead.';
END;
$$ LANGUAGE plpgsql SET search_path = public;

CREATE TRIGGER trg_enforce_journal_entry_immutability
  BEFORE UPDATE ON public.journal_entries
  FOR EACH ROW
  EXECUTE FUNCTION public.enforce_journal_entry_immutability();

-- Trigger: Prevent INSERT/UPDATE/DELETE on journal_entry_lines when parent JE is posted or voided
CREATE OR REPLACE FUNCTION public.enforce_journal_entry_lines_immutability()
RETURNS TRIGGER AS $$
DECLARE
  parent_status TEXT;
BEGIN
  -- For DELETE or UPDATE, check the existing parent
  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    SELECT status INTO parent_status
    FROM public.journal_entries
    WHERE id = OLD.journal_entry_id;

    IF parent_status IN ('posted', 'voided') THEN
      RAISE EXCEPTION 'Cannot modify lines of a % journal entry.', parent_status;
    END IF;
  END IF;

  -- For INSERT or UPDATE, check the target parent
  IF TG_OP IN ('INSERT', 'UPDATE') THEN
    SELECT status INTO parent_status
    FROM public.journal_entries
    WHERE id = NEW.journal_entry_id;

    IF parent_status IN ('posted', 'voided') THEN
      -- Allow INSERT only if the parent was JUST created (within 5 seconds) and is posted
      -- This handles auto-posted entries from useGLPosting which insert header then lines
      IF TG_OP = 'INSERT' AND parent_status = 'posted' THEN
        DECLARE
          parent_created_at TIMESTAMPTZ;
        BEGIN
          SELECT created_at INTO parent_created_at
          FROM public.journal_entries
          WHERE id = NEW.journal_entry_id;

          IF parent_created_at > NOW() - INTERVAL '30 seconds' THEN
            RETURN NEW; -- Allow initial line creation for auto-posted entries
          END IF;
        END;
      END IF;

      RAISE EXCEPTION 'Cannot modify lines of a % journal entry.', parent_status;
    END IF;
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = public;

CREATE TRIGGER trg_enforce_journal_entry_lines_immutability
  BEFORE INSERT OR UPDATE OR DELETE ON public.journal_entry_lines
  FOR EACH ROW
  EXECUTE FUNCTION public.enforce_journal_entry_lines_immutability();
