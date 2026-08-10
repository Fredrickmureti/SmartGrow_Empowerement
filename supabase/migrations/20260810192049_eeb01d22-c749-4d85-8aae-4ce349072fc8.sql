-- ============================================================
-- RFQ Phase 5a — legacy retirement (no fallbacks, hard delete)
-- All affected tables verified empty prior to this migration.
-- ============================================================

-- 1. Legacy supplier-shortlist tables (superseded by
--    rfq_invitations / rfq_quotations / rfq_quotation_items / rfq_awards)
DROP TABLE IF EXISTS public.rfq_vendor_items CASCADE;
DROP TABLE IF EXISTS public.rfq_vendors CASCADE;

-- 2. Unused parallel sourcing engine (never wired to any UI)
DROP FUNCTION IF EXISTS public.award_sourcing_event_atomic(uuid, jsonb, text) CASCADE;
DROP FUNCTION IF EXISTS public.close_sourcing_event(uuid) CASCADE;
DROP FUNCTION IF EXISTS public.open_sourcing_event(uuid) CASCADE;
DROP FUNCTION IF EXISTS public.score_sourcing_vendor(uuid, uuid, jsonb) CASCADE;
DROP FUNCTION IF EXISTS public.create_sourcing_event(uuid, text, text, text, boolean, timestamptz, timestamptz, numeric, uuid, uuid, text, jsonb) CASCADE;
DROP FUNCTION IF EXISTS public.get_next_sourcing_event_number(uuid, uuid, text) CASCADE;
DROP FUNCTION IF EXISTS public._emit_sourcing_outbox(uuid, uuid, text, uuid, text, jsonb, uuid) CASCADE;

ALTER TABLE public.rfqs DROP COLUMN IF EXISTS sourcing_event_id;

DROP TABLE IF EXISTS public.sourcing_vendor_scores CASCADE;
DROP TABLE IF EXISTS public.sourcing_scoring_criteria CASCADE;
DROP TABLE IF EXISTS public.sourcing_event_awards CASCADE;
DROP TABLE IF EXISTS public.sourcing_events CASCADE;
DROP FUNCTION IF EXISTS public.tg_sourcing_events_updated_at() CASCADE;

-- 3. Conversion completeness invariant: an RFQ may only reach `converted`
--    when every award row carries the purchase order it produced.
CREATE OR REPLACE FUNCTION public._rfq_assert_conversion_complete()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.status = 'converted' AND COALESCE(OLD.status, '') <> 'converted' THEN
    IF NOT EXISTS (SELECT 1 FROM public.rfq_awards a WHERE a.rfq_id = NEW.id) THEN
      RAISE EXCEPTION 'RFQ % cannot be converted: it has no awards', NEW.rfq_number
        USING ERRCODE = '23514';
    END IF;
    IF EXISTS (
      SELECT 1 FROM public.rfq_awards a
      WHERE a.rfq_id = NEW.id AND a.purchase_order_id IS NULL
    ) THEN
      RAISE EXCEPTION 'RFQ % cannot be converted: award rows without a purchase order remain', NEW.rfq_number
        USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_rfq_assert_conversion_complete ON public.rfqs;
CREATE TRIGGER trg_rfq_assert_conversion_complete
BEFORE UPDATE ON public.rfqs
FOR EACH ROW EXECUTE FUNCTION public._rfq_assert_conversion_complete();