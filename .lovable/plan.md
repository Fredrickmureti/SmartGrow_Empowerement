# Garnishment / Legal-Order Lifecycle Redesign

Goal: one canonical business-partner spine, one liability sub-ledger, one lifecycle from legal order → payslip → GL → remittance → reconciliation → statement → audit → closure. Localization packs stay statutory-only; workflow stays in core.

## 1. Canonical business lifecycle (target)

```text
Legal Order (draft → active → paused → satisfied/terminated)
   ├── Issuing Authority   (Contact, role=authority)
   ├── Recipient (payee)   (Contact, role=garnishment_recipient, vendor-like)
   └── Employee            (Contact, role=employee)
        ↓ payroll run (per period)
   Payslip line (garnishment kind, priority, cap-aware)
        ↓ approve run
   Journal Entry: Dr Salary Expense/Net Pay clearing  Cr Garnishment Payable / <Recipient sub-ledger>
        ↓ remittance batch (per recipient, schedule-driven)
   Bill / Payable to Recipient (contact_id) → Bank Payment
        ↓
   Bank reconciliation + Recipient Statement + Employee payslip footnote
        ↓
   Audit trail + Statutory reporting (localization pack renders forms)
        ↓
   Closure when total_paid ≥ total_owed OR end_date OR court order lifted
```

Every step already has a table; the redesign eliminates drift between them.

## 2. Current drift (verified)

- **Three overlapping party stores.** `contacts`, `legal_recipients`, and `legal_order_authorities` all model the same real-world entity (a court, agency, SACCO, creditor). `legal_recipients.contact_id` and `legal_order_authorities.contact_id` are *optional* back-links, so the same court can exist as three uncorrelated rows.
- **Free-text payee on the order.** `legal_orders_records` still carries `payee_name / payee_bank / payee_account / payee_reference / payee_contact_id / payee_unmapped` in parallel with `recipient_id` and `authority_id`. Two writers, one truth.
- **Mini-form inline creation.** `AuthorityPicker` + `LinkRecipientDialog` create thin rows that bypass the full Contact master-data lifecycle (addresses, banking, statutory IDs, jurisdictions, comms).
- **Hardcoded GL account.** A single `Garnishment Payable` liability is shared across all recipients — no per-recipient sub-ledger — so remittance/statement reconciliation depends on free-text `payee_reference`.
- **UI naming collides with PAYE.** ADR-0092 patched copy but did not close the model gap.

## 3. Target model

### 3.1 One party spine
- **`contacts`** stays canonical. Introduce role facets on `contact_roles` (or an existing role table):
  - `role='issuing_authority'` with facet row `contact_authority_profile` (authority_type, jurisdiction_country/region, statutory identifiers, remittance_schedule, default reference template).
  - `role='garnishment_recipient'` with facet row `contact_recipient_profile` (aggregate_cap_exempt, always_first, default_payment_method_id, statement_cadence, linked authority_id).
- A single Contact may play both roles (e.g. KRA is authority and recipient of PAYE-adjacent orders). Roles compose; they do not duplicate the party.
- **Retire `legal_recipients` and `legal_order_authorities`** as independent tables. Migrate their rows into `contacts` + facet rows; keep the ids as views for one release for compatibility, then drop.

### 3.2 Legal order references the party spine only
- On `legal_orders_records`: keep `authority_contact_id` and `recipient_contact_id` (FK → contacts). Drop `payee_name/bank/account/reference/contact_id/unmapped` and the `payee_unmapped` trigger — the "recipient not linked" state disappears by construction because you cannot create an order without picking a Contact.
- Remittance instructions (bank, account, reference template) live on the recipient facet, not the order. Per-order override only when it genuinely differs (rare; store on order as a nullable override JSON).

### 3.3 Per-recipient liability sub-ledger
- Keep one control account `Garnishment Payable` (localization-pack seeded, country-agnostic name). Post every accrual and payment with `partner_id = recipient_contact_id` on the journal line.
- Recipient statements, remittance batches, and reconciliation all read the sub-ledger by `partner_id`, mirroring how AP works for vendors. No new account per recipient; no hardcoding.
- If a jurisdiction requires separate control accounts (rare), the localization pack maps `garnishment_payable_by_kind` → account; the resolver picks by `garnishment_kind`.

### 3.4 Remittance = AP bill cycle, specialized
- On payroll approval, the accounting event emits a `remittance_intent` per recipient/period.
- The existing remittance batch page groups intents by recipient + schedule and materializes an AP **Bill** (contact = recipient) with lines referencing the source orders. Payment, bank export, and reconciliation reuse the standard AP payment stack. Statements come free from the AP statement engine, filtered to `role=garnishment_recipient`.

## 4. UX

- **Single "Legal Order" record page** in the payroll workspace with sections: Order details → Employee → Issuing Authority → Recipient → Amounts & caps → Documents → Activity/audit → Related payslips → Related bills.
- **Inline party creation uses the full Contact form** (`ContactRecordForm`) preloaded in a side sheet with `role=issuing_authority` / `role=garnishment_recipient` filter, not a mini dialog. Same lifecycle as any other Contact. Users never leave the order flow.
- Tooltip on any "authority/recipient" label explicitly states it is unrelated to PAYE (retain ADR-0092 guidance).
- Post-create smart defaults: when a recipient is created, the system auto-attaches the default payment method, seeds the reference template from the authority (if any), and pre-selects the recipient on the order.

## 5. Localization boundary

Pack ships:
- statutory garnishment kinds catalog, cap policies, aggregate-cap fractions, priority defaults, minimum take-home fractions (existing `localization_pack_garnishment_policies` — keep).
- seed rows for well-known **authorities** (courts, agencies) as `contacts` with `role=issuing_authority` at install time, idempotently.
- default control account mapping key `garnishment_payable` (and per-kind overrides if the jurisdiction needs it).

Pack does NOT ship: workflows, UI copy, remittance schedules per tenant, or business decisions.

## 6. Phases

Each phase ends with green tests and no regressions in the existing garnishment engine tests (`garnishment-engine.test.ts`, `garnishment_policy_fraction_invariant_test.sql`, phase 2–8 architecture tests).

**Phase A — Party consolidation (DB) — ✅ DONE**
- `contact_authority_profile`, `contact_recipient_profile` shipped with RLS, GRANTs, `updated_at` triggers.
- `legal_orders_records.authority_contact_id` / `recipient_contact_id` added; backfilled from `legal_order_authorities` / `legal_recipients`.
- Compatibility views `legal_order_authorities_v` / `legal_recipients_v` (`security_invoker = on`) keep legacy readers working.

**Phase B — Writer switch — ✅ DONE**
- Security-definer RPCs `party_upsert_authority_from_form` and `party_upsert_recipient_from_form` are the sole atomic writers for authority/recipient party rows + facet + legacy back-link.
- `AuthorityPicker` and `LinkRecipientDialog`'s "New recipient" now open full master-data sheets (identity, statutory ID, address, jurisdiction, default remittance) and route writes through the RPCs.
- `Garnishments.tsx` persists `authority_contact_id` on create/edit alongside `authority_id`.
- Free-text `payee_*` fields are no longer written from the UI (kept readable for legacy rows; retirement lands in Phase E).

**Phase C — Sub-ledger & remittance — 🚧 IN PROGRESS**

_C.1 — Sub-ledger discipline — ✅ DONE_
- `legal_orders` view extended with `recipient_contact_id` and `authority_contact_id`.
- `garnishment_recipient_contact_for_order(uuid)` resolver: prefers Phase-A `recipient_contact_id`, falls back to `payee_contact_id` / recipient-linked contact.
- `post-payroll-gl` stamps `journal_entry_lines.contact_id` (partner) on every Garnishment Payable CR line — one control account, per-recipient sub-ledger.
- `payroll_liabilities.payee_contact_id` now prefers the canonical recipient contact.
- Partial index `journal_entry_lines_contact_id_partial_idx` for sub-ledger read performance at scale.

_C.2 — Remittance = AP bill cycle — ⏳ PENDING (next milestone)_
- Refactor `LegalOrderRemittanceBatch` to materialize an AP **Bill** per recipient/period, sourced from `garnishment_ledger` grouped by `partner_id`.
- Reuse the standard AP payment stack for bank export, payment matching, and reconciliation.
- Recipient statements become AP statements filtered to `role=garnishment_recipient`.
- Add a one-off repair function to backfill `journal_entry_lines.contact_id` on historical garnishment payable rows (join `payroll_liabilities.payee_contact_id` via `journal_entries.reference_id = payroll_run_id`).

**Phase D — Localization pack — ⏳ PENDING**
- `install-localization-pack` step seeds common authorities as Contacts with `role=issuing_authority`, idempotent by `(country, code)`.
- Register `garnishment_payable` mapping key in `payroll_gl_readiness` (verify no country hardcoding).
- Optional per-kind account override table for jurisdictions that require it.

**Phase E — Retire legacy tables — ⏳ PENDING**
- Once no writer references `legal_recipients` / `legal_order_authorities` / `payee_*`, drop the tables + trigger + `payee_unmapped` column via migration. Keep compatibility views one release, then drop.

**Phase F — Lifecycle events & audit — ⏳ PENDING**
- Explicit state transitions on `legal_orders_records.status`: `draft → active → paused → satisfied | terminated`, guarded by trigger (`_legal_order_fsm_guard` is partial).
- Emit `legal_order.*` events to the outbox reactor.
- Closure rule: auto-transition to `satisfied` when `total_paid ≥ total_owed`; `terminated` requires a court reference.

## 7. Verification

- Existing tests remain green; add:
  - Architecture: `no reference to legal_recipients/legal_order_authorities from src/**` after Phase E.
  - Architecture: `legal_orders_records` writers must set `recipient_contact_id`.
  - SQL: control account posts always carry `partner_id`.
  - SQL: create-order transaction fails when `recipient_contact_id` is null.
- Manual walkthrough per country pack (KE + one non-KE) proves: fresh signup → install pack → create order → run payroll → post GL → generate remittance bill → pay → reconcile → statement — with zero manual account or mapping configuration.

## 8. Non-goals / explicitly excluded

- No merging of `Garnishment Payable` with `PAYE Payable` (ADR-0092 stands).
- No new UI for "recipient not linked" — the state ceases to exist.
- No changes to the garnishment computation engine's math (priority ordering, aggregate cap, min take-home) — only its inputs move to the party spine.
- No Supabase Edge Function proliferation; new server work uses `createServerFn`.

## 9. Handoff to next agent

**Currently active phase:** Phase C — Sub-ledger & remittance.
**Next milestone:** Phase C.2 — Remittance = AP bill cycle.

Before writing any new code, verify Phase C.1 landed correctly to enterprise-grade standards:

1. `SELECT recipient_contact_id, authority_contact_id FROM public.legal_orders LIMIT 1;` — must succeed (view exposes both columns).
2. `SELECT public.garnishment_recipient_contact_for_order(<a real order id>);` — must return a non-null uuid for orders that have any of `recipient_contact_id` / `payee_contact_id` / `legal_recipients.contact_id`.
3. Run `post-payroll-gl` dry-run on a run with a garnishment; inspect the returned lines — the `Garnishment Payable` CR line must carry `contact_id = <recipient contact uuid>`, and the debits/credits must still balance.
4. Confirm `journal_entry_lines_contact_id_partial_idx` exists (`\d public.journal_entry_lines` in psql or the SQL editor).
5. Confirm no writer in `src/**` inserts into `journal_entry_lines` for garnishments with `contact_id: null` — the sub-ledger discipline is now a category rule, not a per-run patch.

Then start C.2:

- Model a "remittance intent" projection from `payroll_liabilities` where `rule_code LIKE 'garnishment_%'`, grouped by `(payee_contact_id, period)`.
- On remittance batch confirm, materialize an AP `bills` row (contact = recipient), with `bill_items` referencing the source legal orders; write the payment through the existing AP payment stack rather than the legacy `legal_order_remittance_batches` path (keep the latter as a read-only projection during transition).
- Add an idempotent repair function that backfills `journal_entry_lines.contact_id` on historical garnishment CR rows by joining `journal_entries.reference_id = payroll_run_id` → `payroll_liabilities.payee_contact_id` where `rule_code = 'garnishment_' || <order_id>`. Ship as an SQL function invoked from a one-off admin action, not an automatic migration, so ops can review counts first.

Do not skip ahead to Phase D/E/F. Do not touch the garnishment computation math. Keep the free-text `payee_*` columns readable but never write to them.
