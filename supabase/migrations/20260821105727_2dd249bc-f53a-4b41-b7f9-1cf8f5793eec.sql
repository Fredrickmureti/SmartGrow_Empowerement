-- The new signature adds a defaulted parameter, which creates a second
-- overload; leaving both would make every existing named-argument call
-- ambiguous. There is exactly one posting engine (ADR 0123).
DROP FUNCTION IF EXISTS public.post_journal_entry_atomic(
  uuid, uuid, text, date, text, text, text, uuid, uuid,
  boolean, boolean, jsonb, text, numeric, text, uuid, boolean);

REVOKE ALL ON FUNCTION public.post_journal_entry_atomic(
  uuid, uuid, text, date, text, text, text, uuid, uuid,
  boolean, boolean, jsonb, text, numeric, text, uuid, boolean, boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.post_journal_entry_atomic(
  uuid, uuid, text, date, text, text, text, uuid, uuid,
  boolean, boolean, jsonb, text, numeric, text, uuid, boolean, boolean) FROM anon;
GRANT EXECUTE ON FUNCTION public.post_journal_entry_atomic(
  uuid, uuid, text, date, text, text, text, uuid, uuid,
  boolean, boolean, jsonb, text, numeric, text, uuid, boolean, boolean) TO authenticated, service_role;
