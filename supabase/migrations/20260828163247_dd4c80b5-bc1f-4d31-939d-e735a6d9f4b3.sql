-- The FX revaluation engine posts its journal through post_journal_entry_atomic
-- (which has no journal_book_id parameter) and then stamps the book with a
-- follow-up UPDATE. The immutability trigger refused that UPDATE, so a
-- non-empty revaluation could never be posted at all.
--
-- Allow exactly one narrow case: a NULL -> non-NULL journal_book_id assignment
-- where every other column of the entry is byte-identical. Re-pointing an
-- already-booked entry, or changing anything else, stays refused.
CREATE OR REPLACE FUNCTION public.enforce_journal_entry_immutability()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  reset_org      TEXT;
  narration_flag TEXT;
  lineage_flag   TEXT;
BEGIN
  reset_org := current_setting('app.reset_in_progress', true);
  IF reset_org IS NOT NULL AND reset_org <> ''
     AND COALESCE(NEW.organization_id, OLD.organization_id)::text = reset_org THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
  END IF;

  IF OLD.status NOT IN ('posted', 'voided', 'reversed') THEN
    RETURN NEW;
  END IF;

  -- Book stamp: a posted entry may be filed into a journal book once, and only
  -- once, provided nothing else about it changes.
  IF TG_OP = 'UPDATE'
     AND OLD.journal_book_id IS NULL
     AND NEW.journal_book_id IS NOT NULL
     AND (to_jsonb(NEW) - 'journal_book_id') = (to_jsonb(OLD) - 'journal_book_id')
  THEN
    RETURN NEW;
  END IF;

  -- Lineage repair: only the reversal back-pointer may change, and only
  -- when every other column stays equal.
  lineage_flag := current_setting('app.je_lineage_repair', true);
  IF lineage_flag = 'on'
     AND NEW.status         IS NOT DISTINCT FROM OLD.status
     AND NEW.entry_date     IS NOT DISTINCT FROM OLD.entry_date
     AND NEW.entry_number   IS NOT DISTINCT FROM OLD.entry_number
     AND NEW.description    IS NOT DISTINCT FROM OLD.description
     AND NEW.reference      IS NOT DISTINCT FROM OLD.reference
     AND NEW.source_type    IS NOT DISTINCT FROM OLD.source_type
     AND NEW.source_id      IS NOT DISTINCT FROM OLD.source_id
     AND NEW.total_debit    IS NOT DISTINCT FROM OLD.total_debit
     AND NEW.total_credit   IS NOT DISTINCT FROM OLD.total_credit
     AND NEW.organization_id IS NOT DISTINCT FROM OLD.organization_id
     AND NEW.business_id    IS NOT DISTINCT FROM OLD.business_id
     AND NEW.reversal_of_id IS NOT DISTINCT FROM OLD.reversal_of_id
  THEN
    RETURN NEW;
  END IF;

  narration_flag := current_setting('app.je_narration_repair', true);
  IF narration_flag = 'on'
     AND NEW.status         IS NOT DISTINCT FROM OLD.status
     AND NEW.entry_date     IS NOT DISTINCT FROM OLD.entry_date
     AND NEW.entry_number   IS NOT DISTINCT FROM OLD.entry_number
     AND NEW.source_type    IS NOT DISTINCT FROM OLD.source_type
     AND NEW.source_id      IS NOT DISTINCT FROM OLD.source_id
     AND NEW.source_subtype IS NOT DISTINCT FROM OLD.source_subtype
     AND NEW.total_debit    IS NOT DISTINCT FROM OLD.total_debit
     AND NEW.total_credit   IS NOT DISTINCT FROM OLD.total_credit
     AND NEW.organization_id IS NOT DISTINCT FROM OLD.organization_id
     AND NEW.business_id    IS NOT DISTINCT FROM OLD.business_id
     AND NEW.is_adjusting   IS NOT DISTINCT FROM OLD.is_adjusting
     AND NEW.is_closing     IS NOT DISTINCT FROM OLD.is_closing
     AND NEW.is_reversing   IS NOT DISTINCT FROM OLD.is_reversing
     AND NEW.is_reversal    IS NOT DISTINCT FROM OLD.is_reversal
     AND NEW.reversal_of_id IS NOT DISTINCT FROM OLD.reversal_of_id
     AND NEW.reversed_entry_id IS NOT DISTINCT FROM OLD.reversed_entry_id
     AND NEW.posted_at      IS NOT DISTINCT FROM OLD.posted_at
     AND NEW.posted_by      IS NOT DISTINCT FROM OLD.posted_by
  THEN
    RETURN NEW;
  END IF;

  IF OLD.status = 'posted' AND NEW.status IN ('voided', 'reversed') THEN
    IF NEW.entry_date IS DISTINCT FROM OLD.entry_date
       OR NEW.description IS DISTINCT FROM OLD.description
       OR NEW.reference IS DISTINCT FROM OLD.reference
       OR NEW.entry_number IS DISTINCT FROM OLD.entry_number
       OR NEW.source_type IS DISTINCT FROM OLD.source_type
       OR NEW.source_id IS DISTINCT FROM OLD.source_id
       OR NEW.source_subtype IS DISTINCT FROM OLD.source_subtype
       OR NEW.is_adjusting IS DISTINCT FROM OLD.is_adjusting
       OR NEW.is_closing IS DISTINCT FROM OLD.is_closing
       OR NEW.is_reversing IS DISTINCT FROM OLD.is_reversing
       OR NEW.is_reversal IS DISTINCT FROM OLD.is_reversal
       OR NEW.reversal_of_id IS DISTINCT FROM OLD.reversal_of_id
       OR NEW.reversed_entry_id IS DISTINCT FROM OLD.reversed_entry_id
       OR NEW.posted_at IS DISTINCT FROM OLD.posted_at
       OR NEW.posted_by IS DISTINCT FROM OLD.posted_by
       OR NEW.total_debit IS DISTINCT FROM OLD.total_debit
       OR NEW.total_credit IS DISTINCT FROM OLD.total_credit
       OR NEW.organization_id IS DISTINCT FROM OLD.organization_id
       OR NEW.business_id IS DISTINCT FROM OLD.business_id
    THEN
      RAISE EXCEPTION 'Cannot modify core fields of a posted journal entry. Only voiding/reversing bookkeeping fields are allowed.';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.status IN ('voided', 'reversed') THEN
    RAISE EXCEPTION 'Cannot modify a % journal entry.', OLD.status;
  END IF;

  RAISE EXCEPTION 'Cannot modify a posted journal entry. Create a reversing entry or void it instead.';
END;
$function$;