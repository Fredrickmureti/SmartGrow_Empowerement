
DELETE FROM public.app_included_features
WHERE app_id IN ('documents','sign','spreadsheets');

DROP FUNCTION IF EXISTS public.has_spreadsheet_share_access(uuid) CASCADE;
DROP FUNCTION IF EXISTS public.has_spreadsheet_share_access(uuid, uuid) CASCADE;
