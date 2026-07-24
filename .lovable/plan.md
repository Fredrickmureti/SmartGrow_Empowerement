
# Legal Orders / Garnishments — Verification & Correction Plan

## Verification of previous engineer's work (Phase 1)

I read `.lovable/plan.md`, ADRs 0092–0097, the migration timeline, and the UI writers. The previous engineer's plan.md contradicts the accepted architecture on the two biggest questions.

### What actually shipped and is real

| Layer | Object | Status |
|---|---|---|
| Master data | `legal_recipient_types` catalog + `legal_recipients` (recipient master, unique `(org, contact_id, type, jurisdiction)`, `legal_recipient_merge` RPC) | ✅ ADR-0093, Phase 1 |
| Master data | `legal_order_authorities` (+ mandatory `contact_id` FK, migration `20260724163646`) | ✅ |
| Lifecycle | `_legal_order_fsm_guard` + `garnishment_lifecycle_events` + `apply_system_garnishment_transition` | ✅ ADR-0094 Phase 2 |
| Financial | `garnishment_ledger` projection from `payslip_lines` | ✅ Phase 3 |
| Events | `legal_order_event_dispatch_log`, outbox topics | ✅ ADR-0094 |
| Packs | `garnishment_kind_defaults`, `localization_pack_garnishment_policies` (fraction-form) | ✅ ADR-0095, Phase 6 |
| Remittance | `legal_order_remittance_batches` + `_batch_lines` + build/generate/settle/cancel RPCs + `legal_order_auto_satisfy` | ✅ ADR-0096, Phase 7 |
| Bank rec | `bank_reconciliation_matches.settled_legal_order_remittance_batch_id` FK | ✅ Phase 7 step 2 |
| Nightly | Auto-satisfy cron + recipient statement RPC | ✅ Phase 7 step 3 |
| Reporting | `v_legal_order_audit_timeline`, `legal_order_running_balance`, `legal_order_statutory_report_definitions` | ✅ ADR-0097 Phase 8 |
| Overlay (plan.md) | `contact_authority_profile`, `contact_recipient_profile`, `legal_orders_records.authority_contact_id` / `recipient_contact_id`, `party_upsert_*_from_form` RPCs, compat views | ⚠️ Landed but redundant — being unwound |
| Overlay | `journal_entry_lines.contact_id` stamped for Garnishment Payable + partial index | ✅ correct, keeps |

## Phase 2 — Corrected roadmap (chronological)

### ✅ Phase R1 — Unwind the redundant overlay (DB, structural guardrails) — COMPLETE
- CHECK constraint `legal_orders_records_master_ids_required` enforcing `authority_id IS NOT NULL AND recipient_id IS NOT NULL` — applied and validated against live data (1 row, both IDs populated).
- Facet columns already present on `legal_recipients` / `legal_order_authorities` (verified: `statement_cadence`, `always_first`, `aggregate_cap_exempt`, `default_payment_method_id`, `default_payee_*`).

### ✅ Phase R2 — Rewire writers to the ADR masters (UI) — COMPLETE
- `AuthorityPicker.tsx`: emits only `authority_id`; no longer writes `authority_contact_id`.
- `Garnishments.tsx`: removed `authority_contact_id` from form state, loader, and submission payload.
- `LinkRecipientDialog.tsx`: verified — uses master-only RPCs.
- Architecture test `src/__tests__/architecture.legal-orders-overlay-columns.test.ts` blocks any future `src/` reference to `authority_contact_id` / `recipient_contact_id`.

### ✅ Phase R3 — Consolidate `party_upsert_*_from_form` RPCs — COMPLETE
- `party_upsert_authority_from_form` writes only `contacts` + `legal_order_authorities` (master).
- `party_upsert_recipient_from_form` writes only `contacts` + `legal_recipients` (master); legacy `p_authority_contact_id` param retained as a no-op for signature compatibility.
- `contact_authority_profile` / `contact_recipient_profile` are no longer maintained by the form path.

### ✅ Phase R4a — Edge-function master-data resolution — COMPLETE
- `supabase/functions/post-payroll-gl/index.ts`: resolves partner `contact_id` and authority display name via `legal_recipients` (joined through `recipient_id`) in both the JE-line stamping path and the `payroll_liabilities` upsert path. Legacy `recipient_contact_id` / `payee_contact_id` / `payee_name` retained only as fallback for pre-master orders.
- `supabase/functions/post-garnishment-payment/index.ts`: resolves `authority_name` from `legal_recipients.display_name` with `payee_name` fallback.

### ✅ Phase R4b-pre — Stop all UI writers of `payee_*` snapshot columns — COMPLETE (this turn)
- `src/pages/hr/payroll/Garnishments.tsx`:
  - Removed `payee_name`, `payee_bank`, `payee_account`, `payee_reference` from the form's `empty` state, `openEdit` loader, and submit payload.
  - Replaced the "Recipient & remittance" section-4 inputs with an inline note directing users to the LinkRecipientDialog (recipient master owns identity, bank, and reference template per ADR-0093). Section shows a live badge indicating whether `recipient_id` is linked.
  - Removed the payee-defaults autopopulation branch from `AuthorityPicker.onChange` (the master seeds those on the recipient row itself).
- `src/pages/hr/payroll/LegalOrderRemittanceBatch.tsx`:
  - Query now joins `legal_recipients:recipient_id(display_name)`.
  - CSV export field renamed `payee_name` → `recipient`; table cell resolves via master, falls back to legacy snapshot only when master is absent (pre-master orders).
- Architecture test extended to block `payee_name`/`payee_bank`/`payee_account`/`payee_reference` as object-key writes anywhere under `src/pages`, `src/components`, `src/features`. All 6 tests green.

### ⏭️ Phase R4b — Retire free-text `payee_*` snapshot + overlay FK columns (DB) — NEXT
Preconditions (all satisfied):
- UI writers stopped (R2, R4b-pre). ✅
- Form RPCs stopped syncing overlay tables (R3). ✅
- Edge functions no longer *require* the legacy columns (R4a). ✅
- Architecture guard prevents regressions (R4b-pre). ✅

Migration work to draft (in a SINGLE migration for atomicity):
1. **Recreate the `public.legal_orders` view FIRST with the reduced column set.** Postgres will refuse to drop columns that dependent views select. Query the current definition with `pg_get_viewdef('public.legal_orders'::regclass, true)`, remove the columns being dropped, keep every other projection identical.
2. Drop the trigger and function that maintain `payee_unmapped` on `legal_orders_records`.
3. Data-safety backfill (idempotent, expected to be a no-op thanks to the R1 CHECK): for any `legal_orders_records` where `recipient_id IS NULL` and legacy `payee_*` is populated, materialise a `legal_recipients` row (dedupe via unique index / `legal_recipient_merge`) and link it.
4. `ALTER TABLE public.legal_orders_records DROP COLUMN payee_name, payee_bank, payee_account, payee_reference, payee_contact_id, payee_unmapped, authority_contact_id, recipient_contact_id;`
5. Drop compat views `legal_order_authorities_v` / `legal_recipients_v` if still present.
6. Drop tables `contact_authority_profile`, `contact_recipient_profile` (they carry no new data after R3 and their FKs to `contacts` are the only remaining consumers).
7. Update ADR-0092 note that the "payee_unmapped" state ceased to exist.
8. After migration, tighten `useLegalOrders.LegalOrderRow` / `useGarnishments.Garnishment` TypeScript types to remove the dropped fields (types.ts regenerates automatically post-migration; hooks need a follow-up patch).
9. Delete the `payee_name` fallback branches in `LegalOrderRemittanceBatch.tsx` and the edge functions once types.ts confirms the columns are gone.

### ⏭️ Phase R5 — Auto-provisioning at install time
- `install-localization-pack` seeds well-known authorities as `legal_order_authorities` (contact-backed, idempotent by `(country, code)`), not `contact_authority_profile`.
- Verify no country hardcoding remains in `payroll_gl_readiness`; add per-kind override only if a real jurisdiction demands it.

### ⏭️ Phase R6 — FSM & event completeness audit
- Verify `_legal_order_fsm_guard` covers `draft → active → paused → satisfied | terminated` and outbox emits every transition. Add test that `terminated` requires a court-reference document artifact.

### ⏭️ Phase R7 — Reporting & audit surfaces
- Legal Order record page tab consuming `v_legal_order_audit_timeline` + `legal_order_running_balance` + related payslips + related batches.
- Recipient Statement page reads the ADR-0097 recipient statement RPC — no parallel statement path.

### Non-goals (explicitly excluded)
- No merging of Garnishment Payable with PAYE Payable (ADR-0092 stands).
- No replacement of `legal_order_remittance_batches` with AP `bills` (ADR-0096 stands).
- No changes to the garnishment engine math.
- No new Supabase Edge Functions.

## Technical details

### Data-flow after correction

```text
legal_orders_records
   ├── authority_id  → legal_order_authorities.id
   │                     └── contact_id (NOT NULL) → contacts.id  (party)
   └── recipient_id  → legal_recipients.id
                         ├── contact_id (NOT NULL) → contacts.id  (party-only 0/0)
                         └── recipient_type_code → legal_recipient_types.code
Payslip line → garnishment_ledger → journal_entry_lines(contact_id = recipient.contact_id)
                                     → legal_order_remittance_batches (per recipient/period)
                                       → bank file → payment → bank rec (settled_batch FK)
                                       → recipient statement RPC + v_legal_order_audit_timeline
```

### Verification gates already passing
- ✅ CHECK constraint on `legal_orders_records` requires both master IDs.
- ✅ Architecture test blocks re-introduction of overlay column references in `src/`.
- ✅ Form RPCs write only to master tables.
- ✅ Edge functions read display name / partner contact via master with legacy fallback.

## Handoff to next agent

**Current active phase:** R4b (DB retirement of `payee_*` snapshot and overlay FK columns).

**Before starting R4b, verify (enterprise gate):**
1. Grep `supabase/functions/**` and `src/**` for any remaining *hard requirement* on `payee_name`, `payee_bank`, `payee_account`, `payee_reference`, `payee_contact_id`, `payee_unmapped`, `authority_contact_id`, `recipient_contact_id`. Fallback reads are acceptable and will simply return `null` after the drop; hard requirements are not. Refactor any remaining hard requirement onto master-data resolution before dropping columns.
2. Run `bunx vitest run src/__tests__/architecture.legal-orders-overlay-columns.test.ts` and confirm green.
3. `SELECT count(*) FROM public.legal_orders_records WHERE recipient_id IS NULL OR authority_id IS NULL;` — must return 0 (CHECK constraint should already guarantee this).
4. Enumerate every DB view / function / trigger that references the columns to be dropped:
   `SELECT DISTINCT dep.relname FROM pg_depend d JOIN pg_rewrite r ON r.oid = d.objid JOIN pg_class dep ON dep.oid = r.ev_class WHERE d.refobjid = 'public.legal_orders_records'::regclass;`
   Recreate `public.legal_orders` (view) with the reduced column set as part of the same migration.

**Then execute R4b:** produce a single migration that (a) recreates the `legal_orders` view, (b) drops the `payee_*` trigger, (c) drops the eight columns, (d) drops the compat views and the two `contact_*_profile` tables. Do not skip the view recreation — Postgres will refuse to drop columns referenced by a dependent view.

**After R4b, resume in order:** R5 → R6 → R7. Do not jump into R5–R7 before R4b is green, because the retired-column drop is what makes the rest of the schema honest.
