-- =========================================================================
-- Re-attach critical accounting integrity triggers
-- Functions already exist; we only (re)bind them to the tables.
-- All statements are idempotent (DROP IF EXISTS ... CREATE).
-- =========================================================================

-- 1) Balanced JE enforcement (deferred to end-of-transaction so the header
--    can be inserted before its lines without tripping the check).
DROP TRIGGER IF EXISTS trg_enforce_je_balanced ON public.journal_entries;
CREATE CONSTRAINT TRIGGER trg_enforce_je_balanced
  AFTER INSERT OR UPDATE ON public.journal_entries
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.enforce_je_balanced();

-- 2) Immutability of posted journal entries (header).
DROP TRIGGER IF EXISTS trg_je_immutable ON public.journal_entries;
CREATE TRIGGER trg_je_immutable
  BEFORE UPDATE OR DELETE ON public.journal_entries
  FOR EACH ROW EXECUTE FUNCTION public.enforce_journal_entry_immutability();

-- 3) Immutability of posted journal entry lines.
DROP TRIGGER IF EXISTS trg_jel_immutable ON public.journal_entry_lines;
CREATE TRIGGER trg_jel_immutable
  BEFORE UPDATE OR DELETE ON public.journal_entry_lines
  FOR EACH ROW EXECUTE FUNCTION public.enforce_journal_entry_lines_immutability();

-- 4) Fiscal period lock — block posting/changing date into a closed period.
DROP TRIGGER IF EXISTS trg_fiscal_period_lock ON public.journal_entries;
CREATE TRIGGER trg_fiscal_period_lock
  BEFORE INSERT OR UPDATE OF entry_date, status ON public.journal_entries
  FOR EACH ROW EXECUTE FUNCTION public.enforce_fiscal_period_lock();

-- 5) Auto-resolve fiscal_period_id from entry_date on insert.
DROP TRIGGER IF EXISTS trg_validate_fiscal_period_je ON public.journal_entries;
CREATE TRIGGER trg_validate_fiscal_period_je
  BEFORE INSERT ON public.journal_entries
  FOR EACH ROW EXECUTE FUNCTION public.validate_fiscal_period_for_journal_entry();