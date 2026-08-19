-- The project grants EXECUTE on new functions to anon by default, so a bare
-- REVOKE FROM PUBLIC is not enough: name the roles. This helper is internal to
-- the matching seam and is not part of the client API.
REVOKE ALL ON FUNCTION public._bank_doc_is_spoken_for(text, uuid) FROM anon;
REVOKE ALL ON FUNCTION public._bank_doc_is_spoken_for(text, uuid) FROM authenticated;
REVOKE ALL ON FUNCTION public._bank_doc_is_spoken_for(text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public._bank_doc_is_spoken_for(text, uuid) TO service_role;