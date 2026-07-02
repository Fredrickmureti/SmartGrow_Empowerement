-- Add granular feature permissions to spreadsheet_shares table
-- These allow owners to control what shared users can do

ALTER TABLE public.spreadsheet_shares
ADD COLUMN IF NOT EXISTS can_edit_cells boolean DEFAULT true,
ADD COLUMN IF NOT EXISTS can_manage_charts boolean DEFAULT true,
ADD COLUMN IF NOT EXISTS can_add_sheets boolean DEFAULT true,
ADD COLUMN IF NOT EXISTS can_use_data_sources boolean DEFAULT false,
ADD COLUMN IF NOT EXISTS can_export boolean DEFAULT true;

-- Add comment explaining the columns
COMMENT ON COLUMN public.spreadsheet_shares.can_edit_cells IS 'Whether the user can edit cell values';
COMMENT ON COLUMN public.spreadsheet_shares.can_manage_charts IS 'Whether the user can create, edit, or delete charts';
COMMENT ON COLUMN public.spreadsheet_shares.can_add_sheets IS 'Whether the user can add new sheets to the spreadsheet';
COMMENT ON COLUMN public.spreadsheet_shares.can_use_data_sources IS 'Whether the user can create or use data sources (security-sensitive)';
COMMENT ON COLUMN public.spreadsheet_shares.can_export IS 'Whether the user can export the spreadsheet data';