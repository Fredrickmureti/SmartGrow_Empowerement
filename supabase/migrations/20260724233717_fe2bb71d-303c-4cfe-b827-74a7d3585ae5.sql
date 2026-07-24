
-- ============================================================================
-- Phase R4b: retire legacy payee_* snapshot + overlay FK columns from
-- legal_orders_records. ADR-0093 makes legal_recipients / legal_order_authorities
-- the sole party spine; the snapshot columns and overlay FKs are dead weight.
-- ============================================================================

-- 1. Drop the trigger + function that maintain payee_unmapped
DROP TRIGGER IF EXISTS trg_emp_garn_sync_recipient_mapping ON public.legal_orders_records;
DROP FUNCTION IF EXISTS public.sync_order_recipient_mapping_flag();

-- 2. Safety backfill (expected no-op: the R1 CHECK guarantees both master IDs
--    are populated for every row). Kept for auditability.
DO $$
DECLARE v_bad int;
BEGIN
  SELECT count(*) INTO v_bad
    FROM public.legal_orders_records
   WHERE recipient_id IS NULL OR authority_id IS NULL;
  IF v_bad > 0 THEN
    RAISE EXCEPTION 'R4b abort: % legal_orders_records still missing master IDs', v_bad;
  END IF;
END $$;

-- 3. Drop dependent view public.legal_orders so the ALTER can proceed.
--    CREATE OR REPLACE cannot remove columns from an existing view.
DROP VIEW IF EXISTS public.legal_orders;

-- 4. Drop the retired columns.
ALTER TABLE public.legal_orders_records
  DROP COLUMN IF EXISTS payee_name,
  DROP COLUMN IF EXISTS payee_bank,
  DROP COLUMN IF EXISTS payee_account,
  DROP COLUMN IF EXISTS payee_reference,
  DROP COLUMN IF EXISTS payee_contact_id,
  DROP COLUMN IF EXISTS payee_unmapped,
  DROP COLUMN IF EXISTS authority_contact_id,
  DROP COLUMN IF EXISTS recipient_contact_id;

-- 5. Recreate public.legal_orders with the reduced projection.
--    Same shape as before minus the dropped columns; recipient master fields
--    remain the canonical source of identity.
CREATE VIEW public.legal_orders
WITH (security_invoker = true)
AS
SELECT g.id,
    g.organization_id,
    g.business_id,
    g.employee_id,
    g.employment_id,
    g.kind AS kind_code,
    g.priority,
    g.case_reference,
    g.authority_id,
    g.cap_rule,
    g.fixed_amount,
    g.percent_of_disposable,
    g.total_owed,
    g.total_paid,
    g.total_accrued,
    g.start_date,
    g.end_date,
    g.is_active,
    g.aggregate_cap_exempt,
    g.minimum_take_home_amount,
    g.status,
    g.status_changed_at,
    g.status_changed_by,
    g.status_reason,
    g.payee_payment_method_id,
    g.document_url,
    g.document_filename,
    g.notes,
    g.created_by,
    g.created_at,
    g.updated_at,
    d.calc_model,
    d.priority_class,
    d.protected_earnings_rule,
    d.aggregate_cap_membership,
    d.remittance_schedule_ref,
    d.evidence_requirements,
    d.completion_rule,
    d.reporting_binding_ref,
    d.source_pack_id AS legal_behavior_pack_id,
    g.recipient_id,
    r.display_name AS recipient_name,
    r.recipient_type_code AS recipient_type,
    r.jurisdiction_country AS recipient_jurisdiction_country,
    r.jurisdiction_region AS recipient_jurisdiction_region,
    r.always_first AS recipient_always_first_default,
    r.aggregate_cap_exempt AS recipient_cap_exempt_default
   FROM public.legal_orders_records g
     LEFT JOIN public.garnishment_kind_defaults d
       ON d.organization_id = g.organization_id AND d.kind = g.kind::text
     LEFT JOIN public.legal_recipients r
       ON r.id = g.recipient_id;

GRANT SELECT ON public.legal_orders TO anon, authenticated;

-- 6. Retire the compatibility views seeded by the earlier overlay phase.
DROP VIEW IF EXISTS public.legal_order_authorities_v;
DROP VIEW IF EXISTS public.legal_recipients_v;

-- 7. Retire the orphaned overlay tables. Their writers were stopped in R3;
--    they carry no data the master tables do not already own.
DROP TABLE IF EXISTS public.contact_authority_profile;
DROP TABLE IF EXISTS public.contact_recipient_profile;
