# Legal Orders / Garnishments — Resumption Plan

## Phase 1 verification (independent audit of prior work)

Verified against the live DB, migrations, edge functions, UI, and architecture test suite:

| Prior claim | Verified? | Evidence |
|---|---|---|
| R1: CHECK requires both master IDs | ✅ | Live query: 0 rows with NULL `authority_id`/`recipient_id` out of 1 order |
| R2: UI writers stopped writing `authority_contact_id`/`recipient_contact_id` | ✅ | rg src/ shows zero writes; only type declarations in hooks remain |
| R3: `party_upsert_*_from_form` consolidated to master-only | ✅ | Migration timeline + AuthorityPicker/LinkRecipientDialog code |
| R4a: Edge functions resolve via `legal_recipients` with legacy fallback | ✅ | `post-payroll-gl`, `post-garnishment-payment` both join through `recipient_id` |
| R4b-pre: `payee_*` snapshot writes eliminated in UI, arch guard extended | ✅ | 6/6 arch tests green; no snapshot writes in src/pages, src/components, src/features |
| Overlay tables `contact_authority_profile`, `contact_recipient_profile` no longer maintained | ✅ | Present but orphaned; R3 stopped writers |
| Compat views `legal_order_authorities_v`, `legal_recipients_v` still exist | ⚠️ pending R4b | Both present in DB |
| Snapshot columns still on `legal_orders_records` | ⚠️ pending R4b | 1 row still carries snapshot values |
| View dependencies on dropped columns | ⚠️ 2 dependents | `public.legal_orders` and `public.legal_recipient_outstanding` — both must be recreated first |

**Conclusion:** Prior engineer's R1 through R4b-pre are genuine. Resume at R4b as planned.
The only correction to the prior plan: it enumerated one dependent view (`legal_orders`); the DB shows a second (`legal_recipient_outstanding`) that must also be rebuilt before the DROP COLUMN succeeds.

## Phase 2 additions to the roadmap

While reviewing, three items belong in the plan that were not explicit:

- **R4b.10 — RLS/grants parity check** after view recreation: reapply `security_invoker=true` where the original view carries it, and re-grant SELECT to `authenticated` to match the pre-drop grants.
- **R6.1 — Explicit `terminated` transition evidence** (was implied): require a `document_artifacts` row of kind `legal_order_termination` before `apply_system_garnishment_transition` accepts `active → terminated`. Enterprise systems (SAP HCM, Workday) all require documentary evidence for early termination.
- **R7.1 — Recipient portal read surface**: recipient statement RPC exists (ADR-0097) but has no consumer. Wire it into the Legal Order record page and add a filtered "By recipient" view in `/hr/payroll/legal-orders`. No new RPC.

## Phase 3 — Execution roadmap

### R4b — Retire legacy snapshot & overlay (DB) — **NEXT**

Single atomic migration in this order:

1. `pg_get_viewdef` for both `public.legal_orders` **and** `public.legal_recipient_outstanding`; `CREATE OR REPLACE VIEW` each with the reduced projection (drop `payee_*`, `authority_contact_id`, `recipient_contact_id` references).
2. `DROP TRIGGER` + `DROP FUNCTION` for `payee_unmapped` maintenance on `legal_orders_records`.
3. Idempotent backfill safety net (expected no-op — R1 CHECK holds).
4. `ALTER TABLE public.legal_orders_records DROP COLUMN payee_name, payee_bank, payee_account, payee_reference, payee_contact_id, payee_unmapped, authority_contact_id, recipient_contact_id;`
5. `DROP VIEW public.legal_order_authorities_v, public.legal_recipients_v;`
6. `DROP TABLE public.contact_authority_profile, public.contact_recipient_profile;`
7. Reapply `security_invoker=true` and `GRANT SELECT ... TO authenticated` on the recreated views.
8. Update ADR-0092 note that `payee_unmapped` no longer exists.

**Post-migration (same session, after `types.ts` regenerates):**
- Trim `LegalOrderRow` (`src/hooks/useLegalOrders.ts`) and `Garnishment` (`src/hooks/useGarnishments.ts`) — remove dropped fields.
- Delete `payee_name`/`payee_contact_id`/`payee_unmapped` fallback branches in `LegalOrderRemittanceBatch.tsx`, `post-payroll-gl/index.ts`, `post-garnishment-payment/index.ts`.
- Promote arch test from "no-write" to "no reference" for the four `payee_*` keys.

### R5 — Auto-provisioning at pack install
- Extend `install-localization-pack` to seed jurisdiction-specific `legal_order_authorities` (contact-backed, idempotent on `(country, code)`).
- Remove any residual country hardcoding in `payroll_gl_readiness`.
- Verify `Garnishment Payable` liability account is auto-created on first recipient link (ADR-0092).

### R6 — FSM & event completeness
- Test coverage for `draft → active → paused → satisfied | terminated`; every transition emits to outbox.
- Enforce document-artifact evidence for `terminated`.
- Backfill audit: any historical order without a matching `garnishment_lifecycle_events` row → synthesise one.

### R7 — Reporting & audit surfaces (UI)
- Legal Order record page tab: `v_legal_order_audit_timeline` + `legal_order_running_balance` + related payslips + related batches.
- Recipient Statement page consuming ADR-0097 recipient statement RPC.
- Legal orders index gains a "Group by recipient" view.

### Non-goals (unchanged)
No merging of Garnishment Payable with PAYE Payable; no replacement of `legal_order_remittance_batches` with AP bills; no engine math changes; no new edge functions.

## Technical notes

**Verification gate before executing R4b:**
```
missing_masters=0  rows_with_snapshot=1  total_orders=1
dependents=[legal_orders (view), legal_recipient_outstanding (view)]
overlay_tables=[contact_authority_profile, contact_recipient_profile] (both present, orphaned)
compat_views=[legal_order_authorities_v, legal_recipients_v] (both present)
architecture tests: 6/6 green
```

**Data-flow after R4b:**
```text
legal_orders_records
   ├── authority_id  → legal_order_authorities.id → contacts.id
   └── recipient_id  → legal_recipients.id       → contacts.id
Payslip → garnishment_ledger → journal_entry_lines(contact_id=recipient.contact_id)
                             → legal_order_remittance_batches → bank file → bank rec
                             → recipient statement RPC + v_legal_order_audit_timeline
```
