
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
| Overlay (plan.md) | `contact_authority_profile`, `contact_recipient_profile`, `legal_orders_records.authority_contact_id` / `recipient_contact_id`, `party_upsert_*_from_form` RPCs, compat views | ⚠️ Landed (Phases A/B/C.1) but redundant — see below |
| Overlay | `journal_entry_lines.contact_id` stamped for Garnishment Payable + partial index | ✅ correct, and belongs here regardless |

### Where plan.md is wrong — and needs to be challenged

plan.md diagnosed "three overlapping party stores" (`contacts`, `legal_recipients`, `legal_order_authorities`) and then, instead of *unifying on the ADR-blessed masters*, added a **fourth**: `contact_authority_profile` / `contact_recipient_profile` role facets on `contacts`, plus parallel FK columns `authority_contact_id` / `recipient_contact_id` on the order. This is architecturally wrong for enterprise payroll:

1. **It contradicts ADR-0093 (Accepted).** Every mature enterprise payroll models garnishment recipients as a dedicated **third-party payee master**, not a role tag on the generic party table: SAP HCM "Vendor for garnishment" account group, Oracle HCM Fusion **Third-Party Payment Payee**, Workday **Third Party Payee**, Dynamics 365 F&O **Garnishment vendor account**, Odoo `l10n_*_deduction_partner`. ADR-0093 already picked the correct pattern (`legal_recipients` with `contact_id` back-link + type catalog + merge RPC + `customer_rank=0, supplier_rank=0` party-only rule so recipients don't pollute AR/AP). "Retire `legal_recipients` / `legal_order_authorities`" reverses an accepted ADR without one.

2. **plan.md's Phase C.2 ("remittance = AP bill cycle") contradicts ADR-0096 (Accepted).** Enterprise systems deliberately keep third-party payroll remittances separate from generic AP: SAP HCM Third-Party Remittance Run, Workday Settlement Run, Oracle Third-Party Payroll Payments. Reasons: recipient/period scoping, one bank file per recipient covering N orders across M employees, court-mandated reference lines, distinct statutory reporting, and — critically — different reconciliation semantics. ADR-0096 already shipped the correct dedicated aggregate with idempotent settle, sha256'd bank files, back-links to `legal_order_remittance_lines`, and a bank-rec seam. Refactoring it into AP bills would delete that work and re-introduce reconciliation drift.

3. **Its "smart defaults on recipient create" step overlaps** with logic that already lives on `legal_recipient_types` and `legal_recipients` (statement_cadence, always_first default, cap_exempt default, default payment method). Duplicating it on `contact_recipient_profile` is where drift begins.

4. **The `authority_contact_id` / `recipient_contact_id` columns duplicate `authority_id` / `recipient_id`** (which now transitively resolve to a contact via the mandatory `legal_order_authorities.contact_id` FK and `legal_recipients.contact_id`). Two writers, one truth — the exact drift plan.md set out to fix.

### Corrected direction

Keep the enterprise ADR shape. Delete the fourth party store. The order continues to reference `legal_order_authorities.id` and `legal_recipients.id`; anything that needs "the Contact behind this recipient" reads `legal_recipients.contact_id` (guaranteed non-null now that `legal_order_authorities.contact_id` is required and the recipient master is contact-backed by ADR-0093).

## Phase 2 — Corrected plan

### Phase R1 — Unwind the redundant overlay (DB)
- Reconcile data: for every row in `contact_authority_profile` / `contact_recipient_profile` that has no matching `legal_order_authorities` / `legal_recipients`, upsert it into the ADR-blessed master via the merge-safe path. For rows where both exist, prefer the ADR-blessed row and copy any facet-only columns onto it (`statement_cadence`, `always_first`, `aggregate_cap_exempt`, `default_payment_method_id`, `remittance_schedule`, `default_reference_template`) — add the missing columns to `legal_recipients` / `legal_order_authorities` where they don't yet exist. This makes the ADR masters the strict superset.
- Backfill `legal_orders_records.authority_id` / `recipient_id` from `authority_contact_id` / `recipient_contact_id` on any row where the ADR FK is null.
- Drop the compat views `legal_order_authorities_v` / `legal_recipients_v` after readers migrate (they exist only to serve the overlay).
- Drop columns `legal_orders_records.authority_contact_id`, `legal_orders_records.recipient_contact_id`, tables `contact_authority_profile`, `contact_recipient_profile`, and functions `party_upsert_authority_from_form`, `party_upsert_recipient_from_form`.
- Keep `journal_entry_lines.contact_id` stamping and its partial index — that lands here regardless.

### Phase R2 — Rewire writers to the ADR masters (UI)
- `AuthorityPicker`: create via `legal_order_authorities` insert wrapped in a single security-definer RPC `authority_upsert_from_form` that (a) upserts the backing Contact (party-only unless a role rank is set), (b) inserts/updates the authority row with its mandatory `contact_id`. Emit `{ authority_id }`. Delete `authority_contact_id` from the payload.
- `LinkRecipientDialog`: create via `recipient_upsert_from_form` that upserts the party-only Contact (per ADR-0093 rank rule) and calls the existing dedupe-safe path against `legal_recipients` (respecting the unique index; on hit, offer `legal_recipient_merge`).
- `Garnishments.tsx`: persist only `authority_id` and `recipient_id`; stop reading `authority_contact_id`/`recipient_contact_id` from the row.
- Any consumer needing "the Contact" reads through `legal_recipients.contact_id` / `legal_order_authorities.contact_id`. Add a thin `useContactForRecipient` / `useContactForAuthority` selector so this rule is expressed once.

### Phase R3 — Finish the Contact-form-quality inline creation
The UX correctly asked for a full master-data sheet, not a mini form; keep that. Move the sheet component under `src/features/legalOrders/` and make it render `ContactRecordForm` with `role=party-only` (rank 0/0, `type = null`) plus a stacked `LegalRecipientFacetsForm` / `LegalOrderAuthorityFacetsForm` — the sheet is *one screen*, two persisted rows, one RPC.

### Phase R4 — Retire the free-text payee snapshot (formerly plan.md Phase E)
- Confirm no writer sets `payee_name / payee_bank / payee_account / payee_reference / payee_contact_id / payee_unmapped`. Add an architecture test that fails on new writers.
- Add a one-off backfill that, for each `legal_orders_records` with `recipient_id IS NULL` and non-null `payee_*`, materialises a `legal_recipients` row (dedupe via unique index / merge) and links it, then nulls the snapshots.
- Drop the `payee_unmapped` trigger and the `payee_*` columns. Update ADR-0092 to note that the "recipient unmapped" state ceased to exist.

### Phase R5 — Auto-provisioning at install time (formerly plan.md Phase D, corrected target)
- `install-localization-pack` seeds well-known authorities as **`legal_order_authorities`** (contact-backed, one Contact per real-world authority, idempotent by `(country, code)`) — not as `contact_authority_profile`.
- `payroll_gl_readiness` already exposes `garnishment_payable`; verify no country hardcoding remains and add an optional per-kind override map only if a real jurisdiction demands it (do not build speculatively).

### Phase R6 — FSM & event completeness audit (formerly plan.md Phase F, mostly done)
- Verify `_legal_order_fsm_guard` covers `draft → active → paused → satisfied | terminated` and that the outbox emits every transition. `legal_order_auto_satisfy` already closes on `Σ remittance ≥ total_owed`; add a test that a `terminated` transition requires a court-reference document artifact.

### Phase R7 — Reporting & audit surfaces
- `v_legal_order_audit_timeline` and `legal_order_running_balance` shipped; add a Legal Order record page tab that consumes both (Overview + Timeline + Running balance + Related payslips + Related batches). Recipient Statement page reads from the ADR-0097 recipient statement RPC — do not build a parallel statement path.

### Non-goals (explicitly excluded)
- No merging of Garnishment Payable with PAYE Payable (ADR-0092 stands).
- No replacement of `legal_order_remittance_batches` with AP `bills`. That is the deliberate enterprise pattern per ADR-0096 and every reference ERP.
- No changes to the garnishment engine math (priority, aggregate cap, min take-home).
- No new Supabase Edge Functions; server work is `createServerFn` or SQL.

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

### Migrations required
1. Add facet columns to `legal_recipients` / `legal_order_authorities` if any are missing (superset of `contact_*_profile`).
2. Data copy from `contact_*_profile` → ADR masters; backfill `authority_id` / `recipient_id` from the `*_contact_id` columns.
3. New RPCs `authority_upsert_from_form(...)`, `recipient_upsert_from_form(...)` — SECURITY DEFINER, org-scoped, single transaction.
4. Drop `authority_contact_id`, `recipient_contact_id`, `contact_authority_profile`, `contact_recipient_profile`, `party_upsert_*_from_form`, compat views.
5. Payee snapshot backfill + column drop + trigger drop (Phase R4).

### Verification gates per phase
- Architecture tests: no `src/**` references to `authority_contact_id` / `recipient_contact_id` / `contact_*_profile` / `party_upsert_*_from_form` after R2. No writes to `payee_*` after R4.
- SQL test: every INSERT into `legal_orders_records` must set both `authority_id` and `recipient_id` (add check-trigger).
- SQL test: every `journal_entry_lines` row against the Garnishment Payable account carries a non-null `contact_id`.
- End-to-end (KE + one non-KE pack): fresh signup → install pack → create order (inline recipient creation) → run payroll → post GL → build batch → generate bank file → settle → bank rec → recipient statement → auto-satisfy — all green with zero manual mapping.

## Handoff
Currently active: **Phase R1 — Unwind the redundant overlay**. Do not resume plan.md's Phase C.2 (AP-bill refactor); it would delete ADR-0096. Do not resume Phase E as written until R1–R3 land, because the payee snapshot's only remaining reader today is the overlay's fallback resolver.
