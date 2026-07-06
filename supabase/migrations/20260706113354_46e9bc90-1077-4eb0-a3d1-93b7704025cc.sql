
-- Clear the stale lifecycle outbox row from the earlier version bump so
-- publish_localization_pack_version_sql (which updates the pack row and
-- retriggers the lifecycle emitter) can succeed idempotently.
DELETE FROM public.business_event_outbox
 WHERE idempotency_key LIKE 'localization_pack.updated:%:2026.4.0';

SELECT public.publish_localization_pack_version_sql(
  (SELECT id FROM public.localization_packs WHERE country_code = 'KE'),
  '2026.4.0',
  'v2026.4.0 — Statutory documents structural refresh (certificates + returns). See ADR 0060 §6. Certificate P9A rebuilt to KRA 2024 revision (columns A–K, identity headers, signature, Sec 37 footnote, KRA authority, effective 2024-07-01); Certificate of Service now linked to Ministry of Labour. All 8 KE return templates (P10, P10A, P10D, NSSF_RET, SHIF_RET, AHL_RET, NITA_RET, HELB_LR) refreshed with real effective_date, legal_reference, and regulation_citation. New DB triggers reject legacy stub certificate templates and malformed return templates at write time; lint-localization-pack applies certificate section contract to certs and column/filter/totals contract to returns; publish-localization-pack-version calls the linter as a hard gate. generate-tax-certificate refuses invalid templates with HTTP 422 TEMPLATE_STRUCTURAL_INVALID and writes payroll_diagnostics so the Publisher Health panel surfaces them.'
);
