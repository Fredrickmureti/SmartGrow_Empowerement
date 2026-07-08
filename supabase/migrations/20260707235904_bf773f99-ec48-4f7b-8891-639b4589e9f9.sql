
-- Enterprise Fiscalization D6: legacy backfill + retirement

-- 1) Backfill historical rows from etims_transmission_logs → fiscal_transmissions
--    (map status → state; provenance in metadata; idempotency uses legacy row id)
INSERT INTO public.fiscal_transmissions (
  organization_id, provider_key, document_kind, source_doc_type, source_doc_id,
  idempotency_key, state, attempt_count,
  request_payload, response_payload,
  fiscal_number, transmitted_at, last_error, created_at
)
SELECT
  l.organization_id,
  'kra_etims_oscu' AS provider_key,
  CASE l.document_type
    WHEN 'invoice' THEN 'invoice'
    WHEN 'credit_note' THEN 'credit_note'
    WHEN 'pos' THEN 'sale'
    WHEN 'pos_transaction' THEN 'sale'
    ELSE COALESCE(l.document_type, 'invoice')
  END AS document_kind,
  CASE l.document_type
    WHEN 'invoice' THEN 'invoices'
    WHEN 'credit_note' THEN 'credit_notes'
    WHEN 'pos' THEN 'pos_transactions'
    WHEN 'pos_transaction' THEN 'pos_transactions'
    ELSE 'invoices'
  END AS source_doc_type,
  l.document_id AS source_doc_id,
  'legacy:' || l.id::text AS idempotency_key,
  CASE l.status
    WHEN 'success' THEN 'succeeded'
    WHEN 'failed' THEN 'failed'
    WHEN 'pending' THEN 'queued'
    WHEN 'retrying' THEN 'retry_scheduled'
    ELSE 'failed'
  END AS state,
  COALESCE(l.retry_count, 0) AS attempt_count,
  l.request_payload,
  jsonb_build_object(
    'legacy_response', l.response_payload,
    'legacy_response_code', l.response_code,
    'legacy_response_message', l.response_message,
    'legacy_row_id', l.id,
    'provenance', 'etims_transmission_logs_backfill'
  ) AS response_payload,
  COALESCE(l.response_payload->>'rcptSign', l.response_payload->'data'->>'rcptSign') AS fiscal_number,
  l.transmitted_at,
  l.error_message,
  l.created_at
FROM public.etims_transmission_logs l
WHERE l.document_id IS NOT NULL
ON CONFLICT (organization_id, provider_key, idempotency_key) DO NOTHING;

-- 2) Retire the legacy table for writes; keep read for two releases.
REVOKE INSERT, UPDATE, DELETE ON public.etims_transmission_logs FROM authenticated;
REVOKE INSERT, UPDATE, DELETE ON public.etims_transmission_logs FROM anon;

COMMENT ON TABLE public.etims_transmission_logs IS
  'DEPRECATED: replaced by public.fiscal_transmissions (Kenya eTIMS re-architecture v2026.5.0). '
  'Read-only. Scheduled for removal after two releases.';

-- 3) Guard: if a Kenya org tries to fiscalize with no pack installed, the saga
--    already surfaces this. Add a helper view accountants can drill on.
CREATE OR REPLACE VIEW public.v_fiscal_workspace_health AS
SELECT
  ft.organization_id,
  ft.provider_key,
  count(*) FILTER (WHERE ft.state = 'succeeded') AS succeeded_count,
  count(*) FILTER (WHERE ft.state IN ('queued','transmitting','retry_scheduled')) AS pending_count,
  count(*) FILTER (WHERE ft.state IN ('rejected','failed','dead_letter')) AS failing_count,
  max(ft.transmitted_at) FILTER (WHERE ft.state = 'succeeded') AS last_success_at,
  max(ft.updated_at) AS last_activity_at
FROM public.fiscal_transmissions ft
GROUP BY ft.organization_id, ft.provider_key;

GRANT SELECT ON public.v_fiscal_workspace_health TO authenticated;

-- 4) Backfill fiscal_device_credentials from legacy tax_compliance_configs so
--    Kenya tenants keep working during the transition.
INSERT INTO public.fiscal_device_credentials (
  organization_id, business_id, branch_id, provider_key,
  device_serial, branch_office_id, tax_pin, communication_key_encrypted,
  environment, is_active, initialized_at, metadata
)
SELECT
  tcc.organization_id,
  tcc.business_id,
  NULL::uuid AS branch_id,
  'kra_etims_oscu' AS provider_key,
  COALESCE(tcc.device_serial, tcc.config->>'device_serial'),
  COALESCE(tcc.config->>'bhf_id', '00'),
  tcc.config->>'tin',
  tcc.config->>'communication_key',
  CASE WHEN tcc.is_test_mode THEN 'sandbox' ELSE 'production' END,
  tcc.is_active,
  tcc.last_sync_at,
  jsonb_build_object('provenance','tax_compliance_configs_backfill','legacy_id', tcc.id)
FROM public.tax_compliance_configs tcc
WHERE tcc.provider = 'kra_etims'
  AND tcc.config ? 'tin'
  AND tcc.config ? 'communication_key'
  AND NOT EXISTS (
    SELECT 1 FROM public.fiscal_device_credentials fdc
    WHERE fdc.organization_id = tcc.organization_id
      AND fdc.business_id = tcc.business_id
      AND fdc.provider_key = 'kra_etims_oscu'
      AND fdc.branch_id IS NOT DISTINCT FROM NULL
  );

-- 5) Deprecate the platform_settings Kenya keys (mark, don't delete — admins may
--    still read them; new code paths do not).
UPDATE public.platform_settings
SET description = COALESCE(description,'') || ' [DEPRECATED — see localization_pack_fiscal_providers]'
WHERE setting_key IN ('etims_enabled','etims_environment','etims_api_sandbox_url','etims_api_production_url')
  AND description IS DISTINCT FROM COALESCE(description,'') || ' [DEPRECATED — see localization_pack_fiscal_providers]';
