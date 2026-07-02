-- Add UPDATE policy for public spreadsheets
CREATE POLICY "Public spreadsheet sheets can be edited"
ON public.spreadsheet_sheets
FOR UPDATE
TO anon, authenticated
USING (
  spreadsheet_id IN (SELECT id FROM public.spreadsheets WHERE is_public = true)
)
WITH CHECK (
  spreadsheet_id IN (SELECT id FROM public.spreadsheets WHERE is_public = true)
);

-- Enable realtime for spreadsheet_sheets table
ALTER PUBLICATION supabase_realtime ADD TABLE spreadsheet_sheets;