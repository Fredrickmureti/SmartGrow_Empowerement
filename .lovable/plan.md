## Verification of prior work

Independently verified against the codebase and DB:

**Deliverable 1 — Fiscal core migration: DONE and correct.**
- `fiscal_transmissions` (state machine + idempotency + supersedes FK), `fiscal_provider_circuit`, `fiscal_device_credentials`, `localization_pack_fiscal_providers`, `localization_pack_fiscal_code_maps` all exist with proper GRANTs, RLS, and touch triggers. `pack_rule_type_schemas` row for `fiscal_provider` inserted. `enqueue_fiscal_receipt_required` helper compiles and is exposed.

**Deliverable 2 — Kenya Pack v2026.5.0 seed: DONE.**
- One `kra_etims_oscu` provider row with real sandbox/production URLs, PIN regex `^[APKC][0-9]{9}[A-Z]$`, and full `doc_type_map` (invoice/tax_invoice/credit_note/debit_note/proforma/training/copy), `payment_type_map` (7 methods → KRA 01–07), `tax_category_map` (A–E). Code maps seeded for `tax_category`(5), `payment_type`(7), `sales_type`(3), `receipt_type`(2), `txn_type`(5), `purchase_type`(3).

**NOT done (all remaining deliverables):**
- No consolidated `_shared/etims/adapter.ts`; `invoice.ts`, `creditNote.ts`, `pos.ts`, `registerItem.ts`, `syncCodes.ts`, `init.ts` still contain hard-coded URLs, tax categories, and payment codes.
- No `FiscalComplianceSaga`; no code (edge functions or triggers) writes `fiscal.receipt_required` events. `enqueue_fiscal_receipt_required` is unused. Only mention of "fiscal_receipt_required" outside the migration is the generated types file.
- No triggers on `pos_transactions`, `invoices`, `credit_notes`, `sales_returns`.
- Frontend still calls `functions.invoke("etims-transmit")` directly (usePOSEtims, useTaxCompliance) — pipeline is bypassed.
- No accountant workspace route.
- No backfill from `etims_transmission_logs` → `fiscal_transmissions`.
- No architecture guard tests; no country-agnostic runtime guard; `platform_settings.etims_*` still live.

## Plan to finish (in order — no restart, no re-work of D1/D2)

### D3. Consolidated pack-driven Kenya adapter
- New `supabase/functions/_shared/etims/adapter.ts` exposing `buildKraPayload({ document, docKind, providerRow, codeMaps, credentials })`, `postToKra({ providerRow, endpointPath, payload, credentials })`, `verifyPin(pin, providerRow)`, and a `loadProvider(orgId)` helper that joins `installed_localization_packs` → `localization_pack_fiscal_providers` + `localization_pack_fiscal_code_maps` + `fiscal_device_credentials`. All URLs / tax codes / payment codes / doc-type letters come from pack rows — zero literals.
- Reduce `invoice.ts` / `creditNote.ts` / `pos.ts` to thin `documentKind`-specific mappers of canonical rows → the adapter's `FiscalDocument`. Kill their config fetches, HTTP, and logging duplication.
- `init.ts`, `registerItem.ts`, `syncCodes.ts` refactored to consume `loadProvider` + `fiscal_device_credentials`; drop reads of `platform_settings.etims_*` and `tax_compliance_configs.communication_key/device_serial` (fallback shim reads legacy row for one release with a deprecation log).
- `etims-transmit` edge function becomes the pack-registered `endpoint_edge_function`, routing on `document_kind`.

### D4. Fiscal saga + event triggers + circuit breaker
- New edge function `fiscal-compliance-saga` (cron + outbox drain) that:
  1. Selects `business_event_outbox` rows with `event_type IN ('fiscal.receipt_required','fiscal.receipt_cancelled')` and `status='pending'`.
  2. Resolves provider via `enqueue_fiscal_receipt_required`'s join logic → adapter → `endpoint_edge_function`.
  3. Inserts/updates `fiscal_transmissions` with idempotency key `${source_doc_type}:${source_doc_id}:${sequence_no}`, state transitions `queued → transmitting → succeeded | retry_scheduled | rejected | dead_letter`.
  4. Exponential backoff schedule (30s / 2m / 10m / 1h / 6h / 24h; 6 max attempts → `dead_letter`).
  5. Circuit breaker: on ≥5 consecutive 5xx/timeout per `(org, provider_key)` set `fiscal_provider_circuit.state='open'` for cooloff; half-open probe on `next_probe_at`; close on first success.
  6. On success emit `fiscal.receipt_issued`; on rejection emit `fiscal.receipt_rejected`; on cancellation flow emit `fiscal.receipt_superseded` and link `superseded_by`.
- Migration: DB triggers on `pos_transactions` (INSERT of `state='finalized'`), `invoices` (INSERT + status → issued), `credit_notes` (INSERT), `sales_returns` (INSERT), and a `voided_at`-set trigger emitting `fiscal.receipt_cancelled`. Each trigger calls `enqueue_fiscal_receipt_required` — gate already ensures no-op when tenant has no fiscal provider pack installed.
- Migration: schedule saga drain via pg_cron every 60s.

### D5. Frontend rewiring + Kenya-gated accountant workspace
- Remove direct `supabase.functions.invoke("etims-transmit")` from `src/hooks/usePOSEtims.ts` and `src/hooks/useTaxCompliance.ts` write paths. Replace with a read-only subscription to `fiscal_transmissions` keyed by `source_doc_id`, exposing `{state, attempt_count, last_error, qr_data, fiscal_number}` to existing POS/invoice UIs. Manual "resend" becomes an RPC that flips `state='queued'` and clears `next_attempt_at`.
- New route `/compliance/etims` gated on `installed_localization_packs` having a `fiscal_provider` row → auto-hidden for non-Kenya tenants. Sections: health strip (circuit state, last success, credential countdown, env toggle), queue table (`queued/retry_scheduled/rejected/dead_letter` with resend/skip/supersede — SoD-gated), drill-down (request/response JSON, QR, signature, source-doc link, audit trail), credential rotation panel bound to `fiscal_device_credentials`.
- Onboarding wizard reads `localization_pack_fiscal_providers.pin_regex`, `sandbox_url`, `production_url` — no Kenya literals in TS.

### D6. Legacy backfill + retirement
- Migration to backfill `fiscal_transmissions` from `etims_transmission_logs` (state mapped, `provider_key='kra_etims_oscu'`, provenance in `metadata`).
- `etims_transmission_logs` marked read-only (revoke INSERT/UPDATE/DELETE from authenticated); retained for 2 releases.
- Move `communication_key`/`device_serial` from `tax_compliance_configs` to `fiscal_device_credentials` (pgsodium-encrypted `communication_key_encrypted`); nullify old columns after copy.
- Delete `platform_settings.etims_*` keys after backfill completes; runtime guard in adapter throws a clear "Kenya localization pack not installed — install v2026.5.0" error instead of silent no-op.

### D7. Country-agnostic guard + verification
- Vitest architecture test: grep for `/KRA|eTIMS|etims|kra/` outside `supabase/functions/_shared/etims/**`, `supabase/functions/etims-*/**`, `src/routes/compliance/etims/**`, and the Kenya pack seed migrations — fail on any hit.
- Playwright end-to-end: POS sale (KRA sandbox stubbed) → exactly one `fiscal.receipt_required` row → `fiscal_transmissions` row transitions `queued → transmitting → succeeded` → QR block on printed receipt.
- Kill-network test: sandbox returns 500 five times → circuit opens, POS keeps selling, queue drains after breaker half-opens.
- Credit-note test: reissuance links `superseded_by` back to original transmission.
- Ghana tenant smoke test: no `/compliance/etims` route, no `fiscal_transmissions` rows, no `etims-transmit` invocation.

## Execution notes
- One migration per deliverable to keep review chunks small; each new `public.` table gets explicit GRANTs and RLS in the same file.
- No touching of unrelated modules; no non-Kenya packs modified.
- `platform_settings.etims_*` deletion is the last step, gated on backfill + tests green.

Approve to proceed straight into D3.