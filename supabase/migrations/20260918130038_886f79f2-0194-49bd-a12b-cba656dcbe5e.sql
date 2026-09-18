CREATE OR REPLACE FUNCTION public._fa_guard_asset_delete()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF COALESCE(OLD.accumulated_depreciation, 0) <> 0
     OR EXISTS (SELECT 1 FROM public.depreciation_schedules d WHERE d.asset_id = OLD.id)
     OR EXISTS (SELECT 1 FROM public.depreciation_entries e WHERE e.asset_id = OLD.id)
     OR EXISTS (
          SELECT 1 FROM public.journal_entries je
           WHERE je.source_id = OLD.id
             AND je.source_type IN ('asset_acquisition', 'depreciation', 'asset_disposal')
             AND COALESCE(je.status::text, 'posted') NOT IN ('voided', 'reversed')
             -- a reversing entry is not live history; it cancels an entry
             AND COALESCE(je.is_reversal, false) = false
             AND je.reversal_of_id IS NULL)
  THEN
    RAISE EXCEPTION 'FA_ASSET_HAS_ACCOUNTING: asset % has posted accounting history and cannot be deleted; dispose or retire it instead', OLD.asset_number
      USING ERRCODE = '22023';
  END IF;
  RETURN OLD;
END;
$function$;

DELETE FROM public.fixed_assets WHERE id = 'b887fbeb-48be-4868-b175-e466eaa18daf';