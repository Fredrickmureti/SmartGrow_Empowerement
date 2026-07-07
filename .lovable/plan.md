# Kenya eTIMS — Enterprise Fiscalization Re-Architecture

## Business event we are modelling
`fiscal.receipt_required` — emitted whenever a Kenyan tenant commits a sale, issues an invoice, credit note, debit note, return, exchange, cancellation, or correction. Everything below serves that single event, end-to-end.

## What exists today (findings)

Traced from POS/Sales → Inventory → Accounting → Tax → Localization → Platform:

1. **Direct-call topology, not event-driven.** `usePOSEtims`, `useTaxCompliance`, and invoice/credit-note flows call `supabase.functions.invoke("etims-transmit", ...)` inline. There is no publish to `business_event_outbox`; `BusinessSaga` never sees fiscal events. A dropped network mid-checkout means a missing fiscal receipt with no durable retry.
2. **Kenya leaks into platform core.** `platform_settings` holds `etims_enabled / etims_environment / etims_api_sandbox_url / etims_api_production_url`. `_shared/etims/invoice.ts` hard-codes `https://etims-api-sbx.kra.go.ke`, tax categories A–E, and KRA payment codes 01–06. `etims_standard_codes`, `etims_tax_categories`, `etims_transmission_logs` sit in the public schema unconditionally, visible to Ghana/Rwanda/etc. tenants.
3. **Duplicated adapters per document type.** `invoice.ts` (465), `creditNote.ts` (361), `pos.ts` (368), `registerItem.ts` (296), `syncCodes.ts` (325), `init.ts` (298) each rebuild their own KRA payload, config fetch, HTTP call, logging, and error handling. Debit notes, returns, exchanges, cancellations, corrections are not covered coherently.
4. **Credentials posture.** `tax_compliance_configs.communication_key` and `device_serial` are stored as columns with no vault/pgsodium; no rotation surface, no expiry tracking, no per-branch `bhf_id` model (multi-branch tenants can't fiscalize separately).
5. **Reference data ownership wrong.** KRA standard codes and A–E tax categories are per-organization rows, but KRA publishes them globally. They should be pack-owned reference data synced by a platform job.
6. **No accountant workspace.** Transmission status is scattered across POS toasts and settings; no queue, no health, no resend, no audit drill-down, no KRA-outage banner.
7. **Publisher parity gap.** Localization pack tables cover chart, tax, payroll, returns — but there is no `pack_fiscal_provider`, `pack_fiscal_document_types`, `pack_fiscal_tax_code_map`, `pack_fiscal_payment_code_map`, or `pack_fiscal_receipt_template`. The Kenya pack cannot publish eTIMS as an artifact today.
8. **Fiscal block is print-only.** `_shared/pos/fiscalBlock.ts` correctly abstracts the on-receipt QR/CU/signature block, but the same abstraction is not applied to *transmission*.

## Target architecture (SAP/Odoo/Oracle-shaped)

Fiscalization is a **country-agnostic compliance service** invoked by an event bus and implemented by **provider adapters** registered through installed localization packs. Sales/POS/AR know nothing about KRA; the Kenya Pack owns everything Kenya-specific.

```text
        Sales / POS / AR / Returns
                 │
                 ▼  (DB trigger writes row)
        business_event_outbox
        type = fiscal.receipt_required
                 │
                 ▼
        FiscalComplianceSaga  (BusinessSaga handler)
                 │  resolve country -> installed pack -> provider adapter
                 ▼
        Provider Adapter Registry
        ├── kra_etims  (Kenya pack)
        ├── zra_smart  (Zambia pack, future)
        └── efris      (Uganda pack, future)
                 │
                 ▼
        Canonical FiscalDocument → provider payload → HTTP
                 │
                 ▼
        fiscal_transmissions (state machine)
        queued → transmitting → succeeded / rejected / failed / superseded
                 │
                 ▼  emit fiscal.receipt_issued / fiscal.receipt_rejected
        Receipt print pipeline / Accountant workspace / GL narration
```

## Scope of changes (Kenya eTIMS only — nothing else touched)

### 1. Country-agnostic core (new)
- New table `fiscal_transmissions` (provider-agnostic, replaces the semantics of `etims_transmission_logs` for new writes; old table retained read-only for history).
  - Columns: `provider_key`, `document_type`, `document_id`, `sequence_no`, `idempotency_key` (unique), `state`, `attempt_count`, `last_error`, `request_payload`, `response_payload`, `signature`, `qr_data`, `fiscal_number`, `transmitted_at`, `superseded_by`.
- New domain event types on the outbox: `fiscal.receipt_required`, `fiscal.receipt_issued`, `fiscal.receipt_rejected`, `fiscal.receipt_cancelled`, `fiscal.receipt_superseded`.
- DB triggers on `pos_transactions`, `invoices`, `credit_notes`, `sales_returns`, and cancellation paths enqueue `fiscal.receipt_required` **only when the org's active country pack advertises a fiscal provider** — check gated in trigger, no country name appears in trigger body.
- New `FiscalComplianceSaga` (extends `BusinessSaga` handler set) that:
  - resolves `(org, branch) → installed_localization_pack → pack_fiscal_provider`;
  - loads the canonical `FiscalDocument` view for the source row;
  - dispatches to the adapter edge function named by the pack;
  - writes `fiscal_transmissions` with idempotency;
  - retries with exponential backoff up to N attempts, then dead-letters;
  - publishes result event for downstream (print, GL narration, accountant workspace).

### 2. Publisher parity — Kenya Pack owns everything Kenya
New pack tables (added to the localization publisher):
- `localization_pack_fiscal_providers` — `{ provider_key='kra_etims', endpoint_edge_function, sandbox_url, production_url, doc_type_map, payment_type_map, tax_category_map, pin_regex, receipt_footer_legal_text }`.
- `localization_pack_fiscal_document_types` — NS / NC / ND / TR mappings.
- `localization_pack_fiscal_code_maps` — item classification, UoM, packaging codes (was `etims_standard_codes`, now pack-owned reference data).
- `localization_pack_fiscal_receipt_template` — QR/CU/signature block layout + legal footer; consumed by existing `mapEtimsToFiscalBlock` renamed to generic `mapFiscalBlock`.
- New pack rule type `fiscal_provider` registered in `pack_rule_type_schemas`.

Kenya Pack v2026.5.0 publishes rows for all of the above. Ghana/Rwanda packs remain untouched — non-Kenyan tenants get no eTIMS UI, no eTIMS tables in RLS-visible reads, no eTIMS edge function invocation.

### 3. Kenya adapter refactor (edge function)
- Fold `_shared/etims/{invoice,creditNote,pos}.ts` into a single `_shared/etims/adapter.ts` that accepts a canonical `FiscalDocument` and a `document_kind` (`sale|invoice|credit_note|debit_note|return|cancellation|correction`) and emits the correct KRA payload.
- `init`, `registerItem`, `syncCodes` stay as separate operations but read config from the pack row + tenant secrets, not from `platform_settings`.
- All KRA URLs, tax categories A–E, payment codes, and doc-type letters come from the Kenya Pack row — no literals in the edge function.

### 4. Credentials & multi-branch identity
- Move `communication_key` and `device_serial` off `tax_compliance_configs` into `organization_statutory_identifiers` (per-branch: `kra_pin`, `bhf_id`, `device_serial`, `communication_key` encrypted with pgsodium).
- Add rotation surface + expiry tracking (`credential_rotated_at`, `credential_expires_at`, alerting via existing `notification_alert_settings`).
- PIN validation regex sourced from the pack (`^[AP]\d{9}[A-Z]$`) — not hard-coded anywhere in TS.

### 5. Resilience state machine
`fiscal_transmissions.state` transitions:
`queued → transmitting → succeeded` (happy path) / `→ retry_scheduled` (transient failure, backoff 30s/2m/10m/1h/6h/24h) / `→ rejected` (KRA business-rule refusal, needs accountant action) / `→ dead_letter` (exceeded attempts) / `→ superseded` (invoice reissued/corrected).
KRA-offline handled by a global circuit breaker keyed on `provider_key`; opens after N consecutive 5xx/timeout, half-opens after cooloff, closes on first success. All in-flight events remain `queued` while open — POS keeps operating in offline-fiscalization mode with a visible tenant banner.

### 6. Accountant workspace (Kenya-gated)
New route `/compliance/etims` mounted only when the Kenya Pack is installed. Sections:
- Health strip: circuit-breaker state, last successful transmission, credential expiry countdown, sandbox/production toggle.
- Queue: `queued`, `retry_scheduled`, `rejected`, `dead_letter` — filterable, resend/skip/supersede actions with SoD-gated confirmation.
- Drill-down per transmission: request payload, KRA response, signature/QR/CU, source document link, audit trail.
- Cancellations & credit-note wizard tied to the same event pipeline.

### 7. Legacy migration
- Backfill `fiscal_transmissions` from `etims_transmission_logs` (preserve history, mark provenance).
- Keep `etims_transmission_logs` read-only for 2 releases, then drop.
- Retire `platform_settings.etims_*` keys after Kenya Pack v2026.5.0 install; add a runtime guard that fails-fast with a clear error if a Kenya tenant has no installed pack (no silent no-op).

## Deliverables (in this order)
1. Migration: `fiscal_transmissions`, event types, triggers, per-branch statutory identifier columns, pgsodium encryption, new pack tables, `pack_rule_type_schemas` row.
2. Kenya Pack v2026.5.0 publish: seed provider config, tax-category map, payment-code map, doc-type map, receipt template, PIN regex, standard-code sync job registration.
3. Saga: `FiscalComplianceSaga` handler + adapter registry + circuit breaker.
4. Edge functions: consolidated `etims/adapter.ts`; `etims-transmit` becomes the thin Kenya adapter endpoint the pack points to; remove hard-coded URLs and category constants.
5. Frontend: remove direct `functions.invoke("etims-transmit")` calls from `usePOSEtims` and `useTaxCompliance` write paths (they instead observe `fiscal_transmissions` state); onboarding wizard reads pack metadata; accountant workspace route.
6. Migration/backfill of `etims_transmission_logs` → `fiscal_transmissions`.
7. Country-agnostic guard tests: architecture test asserting no `KRA|eTIMS|etims|kra` string outside `_shared/etims/**`, the Kenya Pack rows, and Kenya-gated frontend routes.

## Explicit non-goals
- No changes to payroll, non-Kenya packs, GL posting, inventory costing, or the payment reversal engine.
- No new UI beyond the eTIMS accountant workspace and the onboarding wizard.
- Not building Zambia/Uganda adapters — only proving the abstraction with Kenya.

## Verification
- Reproduce a POS sale end-to-end in Playwright with KRA sandbox stubbed, assert one `fiscal.receipt_required` row, one `fiscal_transmissions` row transitioning `queued → transmitting → succeeded`, and a QR block on the printed receipt.
- Kill-network test: sandbox returns 5xx → circuit opens → POS keeps selling → circuit closes → queue drains automatically.
- Credit-note test: reissuance produces `superseded` link back to original transmission.
- Architecture test: grep for Kenya literals outside allowed paths returns zero.
- Ghana tenant smoke: no eTIMS route visible, no eTIMS edge function invoked, no `fiscal_transmissions` rows produced.

Approve to proceed; I will execute the deliverables in order without further architectural questions.
