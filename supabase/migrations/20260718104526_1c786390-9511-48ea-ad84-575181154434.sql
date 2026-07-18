
CREATE OR REPLACE FUNCTION public.sync_recommendation_from_po()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
BEGIN
  IF TG_OP='UPDATE' AND NEW.status IS DISTINCT FROM OLD.status THEN
    IF NEW.status::text IN ('received','closed') THEN
      UPDATE public.procurement_recommendations
      SET status='fulfilled', updated_at=now()
      WHERE linked_po_id=NEW.id AND status='executing';
    ELSIF NEW.status::text IN ('cancelled','rejected') THEN
      UPDATE public.procurement_recommendations
      SET status='open', linked_po_id=NULL,
          actioned_at=NULL, actioned_by=NULL,
          actioned_ref_type=NULL, actioned_ref_id=NULL,
          updated_at=now()
      WHERE linked_po_id=NEW.id AND status='executing';
    END IF;
  END IF;
  RETURN NEW;
END $$;
