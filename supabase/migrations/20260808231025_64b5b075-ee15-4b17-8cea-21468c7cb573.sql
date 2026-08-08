-- The estimate status writer exists and is executable, but PostgREST was
-- still serving a schema snapshot taken before it was created, so the API
-- answered 404 (PGRST202) for a function the database has. Force the API
-- layer to re-read the catalog.
NOTIFY pgrst, 'reload schema';