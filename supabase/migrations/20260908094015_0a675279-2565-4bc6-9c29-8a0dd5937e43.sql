ALTER TABLE public.journal_books DROP CONSTRAINT IF EXISTS journal_books_journal_type_check;
ALTER TABLE public.journal_books ADD CONSTRAINT journal_books_journal_type_check
  CHECK (journal_type = ANY (ARRAY['sale','purchase','bank','cash','general','situation','lending']));
-- Rollback:
-- ALTER TABLE public.journal_books DROP CONSTRAINT journal_books_journal_type_check;
-- ALTER TABLE public.journal_books ADD CONSTRAINT journal_books_journal_type_check
--   CHECK (journal_type = ANY (ARRAY['sale','purchase','bank','cash','general','situation']));
