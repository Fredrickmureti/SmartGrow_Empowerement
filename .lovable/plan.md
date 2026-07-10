
# Scrap / Waste — Business-Event Lifecycle (Investigation + Implementation Plan)

## 1. What exists today (verified)

- **UI:** `src/pages/inventory/ScrapNew.tsx` — 4 inputs (product, warehouse, qty, reason, notes). Reason is a hard-coded string list. Cost is silently pulled from `products.cost_price` on the client and passed to the RPC.
- **RPC:** `record_scrap_atomic` (migration `20260413031122`). Immediately, in one call:
  1. Inserts one row into `stock_movements` (`movement_type='scrap'`, `quantity=-abs`, `unit_cost=p_unit_cost`).
  2. Locates accounts by hard-coded `detail_type` (`inventory` → `inventory_adjustment` → falls back to `operating_expenses`). Ignores `default_accounts` / `resolve_default_account` and ignores `branch_id`.
  3. Posts a `journal_entries` row with `source_type='scrap'`, status `posted`, in one shot. No approval state, no draft.
- **No header record** — scrap is a bare movement, not a document. `stock_adjustments` is NOT used for scrap despite existing.
- **No SoD trigger** for scrap (compare `sod_stock_adjustment_guard` per `mem/features/sod-self-action`).
- **No outbox emission** — the domain event bus lists `stock_adjustment.approved` but nothing emits a scrap event.
- **No lot / serial / expiry handling.** Outbound FIFO consumption via `consume_lots_atomic` accepts `scrap`, but the scrap RPC never calls it.
- **No reason master data**, no attachments, no reversal, no thresholds, no dashboards.
- **Peek:** the log page shows plain `stock_movements` rows — no drill-down to JE, no financial impact card, no status.

The current build is a **movement + JE**, not a business event. Every enterprise concern below is either missing or bypassed.

## 2. Enterprise lifecycle (target)

```text
Request  →  Review/Approve (policy)  →  Post  →  Inventory move + Costing (AVCO/FIFO/lot)
   │            │                        │             │
   │            └─ SoD guard             │             ├─ warehouse_stock update
   │            └─ approval_requests     │             ├─ cost_layer consumption
   │                                     │             └─ lot / expiry reservation
   │                                     ▼
   │                             GL posting (reason-keyed accounts, branch-aware)
   │                                     │
   │                                     ├─ audit_logs
   │                                     ├─ business_event_outbox → BusinessSaga
   │                                     ├─ notifications (finance, ops)
   │                                     └─ reporting / dashboards / statements
   ▼
Reversal (mirror JE, restore stock, immutable trail)
```

Mapped onto our existing frameworks:

| Concern | Reuse (do NOT reinvent) |
| --- | --- |
| Header document | `stock_adjustments` + `stock_adjustment_items` (already models qty/cost/warehouse/lot) — extend with `type='scrap'` |
| Approval | `approval_workflows` / `approval_rules` / `approval_requests` |
| SoD / self-approval | `governance_assert_not_self`, `self_action_policy`, `sod_<table>_guard` pattern (Wave G2) |
| Accounts | `default_accounts` + `resolve_default_account` RPC (branch-aware, ADR-0016) |
| Reason master data | new `scrap_reasons` config table (org-scoped, seeded per locale) |
| Costing | `resolve_adjustment_unit_cost` + `consume_lots_atomic` (lot-aware, ADR-0025) |
| Domain event | `business_event_outbox` → `stock_adjustment.approved` extended with `scrap.posted` |
| Audit | existing `audit_logs` trigger surface |
| Reporting | `stock_movements` + JE, plus new views for dashboards |

## 3. Root architectural fixes

### 3.1 Promote scrap to a document
- Every scrap becomes a row in `stock_adjustments` with a new discriminator `adjustment_type='scrap'` (column exists as `reason`; add `adjustment_type` enum: `stock_take`, `physical_count`, `scrap`, `revaluation`, `opening_balance`). Lines go in `stock_adjustment_items` — one row per product/lot.
- Numbering `SCR-YYYY-NNNN` via `invoice_sequences`-style helper already used elsewhere.
- Statuses: `draft → pending_approval → approved → posted → reversed`.

### 3.2 Split the RPC into three
Replace the monolithic `record_scrap_atomic` with:
1. `create_scrap_atomic(header, lines[])` — writes draft/pending. No stock or GL.
2. `approve_scrap_atomic(id)` — SoD-guarded (`governance_assert_not_self`), consumes approval override if needed, transitions to `approved`, then internally calls posting.
3. `post_scrap_atomic(id)` — atomic: lock stock, resolve costs, consume lots (FIFO/FEFO), write movements, post JE, emit outbox event, insert `audit_logs`. Same shape as the hardened `approve_stock_adjustment_atomic` (see `docs/audit/2026-05-21-inventory-adjustment-gl.md`).
4. `reverse_scrap_atomic(id, reason)` — mirror JE, restore stock, mark reversed, immutability trigger blocks edits after posting.

### 3.3 Reason as master data
- New `scrap_reasons(id, org_id, code, label, requires_attachment, requires_approval_above, offset_account_purpose, insurance_claim_flag, quality_hold_flag, regulatory_reporting_flag, is_active, sort_order)`.
- Seed from localization pack: `damaged`, `expired`, `defective`, `obsolete`, `quality_reject`, `manufacturing_scrap`, `theft_shrinkage`, `sample_giveaway`, `hazardous_disposal`, `other`.
- `offset_account_purpose` is the key that resolves to a GL account via `resolve_default_account` — one row per reason enables reason-keyed offset accounts (Phase D of the adjustment fix).

### 3.4 Branch-aware, reason-keyed GL
Add default-account purposes: `scrap_expense_damaged`, `scrap_expense_expired`, `scrap_expense_obsolete`, `scrap_expense_quality`, `scrap_expense_manufacturing`, `scrap_expense_shrinkage`, `scrap_expense_default`.
`post_scrap_atomic` resolves offset per line by `resolve_default_account(business_id, reason.offset_account_purpose, header.branch_id)`, falling back to `scrap_expense_default`, then `inventory_adjustment`. Inventory side resolves from `products.inventory_account_id` → `default_accounts` `inventory_asset`. Fast-fail if either is missing — no silent skip.

### 3.5 SoD + governance
- Add `sod_stock_adjustment_scrap_guard` on `BEFORE UPDATE OF status` to `stock_adjustments` where `adjustment_type='scrap'` and `NEW.status IN ('approved','posted')` — calls `governance_assert_not_self(created_by, approved_by, 'scrap.approve')`.
- Register catalog entry in `src/lib/governance/selfActionCatalogue.ts`: `scrap.approve` (block by default), `scrap.post`, `scrap.reverse`.
- Thresholds: reuse `approval_rules` targeting `stock_adjustments`, add pre-built rule "Scrap > X value requires manager approval". Rule value comes from `businesses.scrap_auto_approve_threshold` (new col) — org-configurable, defaults from localization pack.

### 3.6 Lot / serial / expiry
When `products.track_lots` or `products.track_serials` is true, `post_scrap_atomic` requires each line to carry `lot_id` (or serials) and calls `consume_lots_atomic('scrap', …)` for the FIFO consumption. Blocks scrap if reserved stock (`stock_reservations`) would be violated — checks `warehouse_stock.quantity_available`.

### 3.7 Domain event + saga
- Emit `scrap.posted` (new `DomainEventType`) into `business_event_outbox`.
- Register handlers via `BusinessSaga`: label printing (disposal label), notification to finance & warehouse manager, insurance claim webhook when `reason.insurance_claim_flag`, quality-hold check when `reason.quality_hold_flag`, regulatory registry write for `controlled_substance_register` when applicable.

### 3.8 Attachments
`stock_adjustment_attachments` (already implied by `project_documents` pattern) — table `scrap_attachments(scrap_id, storage_path, kind='photo'|'disposal_certificate'|'insurance_form', uploaded_by, uploaded_at)` gated by reason master data (`requires_attachment=true` blocks posting).

### 3.9 Reversal + immutability
- After `status='posted'`, `BEFORE UPDATE` trigger blocks edits to header/lines except a status transition to `reversed` written by `reverse_scrap_atomic`.
- Reversal writes a mirror JE (`source_type='scrap_reversal'`, links to original), inverse `stock_movements`, and marks header `reversed_by/reversed_at/reversal_reason`.

## 4. UX rebuild (`/inventory-app/scrap` + `/inventory-app/scrap/new`)

Log page becomes an **operational dashboard**:
- KPI strip: Pending approval, Approved / not posted, Posted today, Posted MTD, Financial loss MTD, Top reason, Warehouse with highest loss.
- Filters: status, reason, warehouse, product, date range, requester, approver.
- Row → right `DetailSheet` (per `docs/architecture/OVERLAYS.md`) showing header, lines with cost, journal entry link, movement link, audit trail, attachments, reversal button (permission-gated).

New/edit page becomes a **multi-line document**:
- Header: warehouse, branch (defaults from context), reason (from master data), reference #, occurrence date, attachments, notes.
- Lines table: product, lot (when tracked), qty, unit cost (server-resolved, editable with permission), total value.
- Right rail: running total value, GL preview (accounts that will be hit, per reason), governance banner ("Requires approval by …", "SoD block: you cannot approve your own scrap"), attachment gate.
- Submit routes: "Save draft", "Submit for approval", or "Approve & post" (only if under threshold AND user has `scrap.post`).

Config page under `Setup`:
- `/inventory-app/setup/scrap-reasons` — CRUD for `scrap_reasons` (flags, offset account purpose picker).
- Default-account settings section under existing Finance settings gets the seven `scrap_expense_*` purposes.

## 5. Files & migrations

### Migrations (in order)
1. `stock_adjustments`: add `adjustment_type` enum + column (default `stock_take`); add `reversed_by`, `reversed_at`, `reversal_reason`, `reversal_of_id`. Backfill existing rows to `stock_take`.
2. `scrap_reasons` table + GRANTs + RLS + seed defaults.
3. `default_accounts`: register new `scrap_expense_*` purposes (via `default_account_settings` catalog).
4. `scrap_attachments` table + storage bucket convention row.
5. RPCs: `create_scrap_atomic`, `approve_scrap_atomic`, `post_scrap_atomic`, `reverse_scrap_atomic`. Drop-in replaces the old `record_scrap_atomic` (kept as a thin wrapper that calls create+approve+post so any external caller still works, then deprecated).
6. Triggers: `sod_stock_adjustment_scrap_guard`, `enforce_scrap_immutable_after_post`.
7. Outbox event type `scrap.posted` (extend `business_event_outbox` allowed types) + saga registration in `BusinessSaga.ts`.
8. Governance catalog rows for `scrap.approve`, `scrap.post`, `scrap.reverse`.

### Frontend
- Replace `src/pages/inventory/ScrapNew.tsx` with document-shaped form (lines editor). Reuse `RecordFormShell`, existing `StockLine` component pattern from adjustments.
- Rebuild `src/pages/inventory/ScrapRecording.tsx` as a filtered list + KPIs + DetailSheet.
- New `src/pages/inventory/ScrapDetail.tsx` (peek sheet body) + reversal action.
- New `src/pages/inventory/setup/ScrapReasons.tsx` for master data.
- Extend `src/lib/governance/selfActionCatalogue.ts` and `src/services/events/domainEventBus.ts` (`scrap.posted`).
- Extend `useInventory` / add `useScrap` hook wrapping the four RPCs with react-query invalidations.

### Architecture guards (tests)
- `src/test/architecture/scrap-lifecycle.test.ts` — asserts:
  - RPC set is present and old `record_scrap_atomic` is only a wrapper.
  - `stock_adjustments.adjustment_type` and `scrap_reasons` exist.
  - SoD trigger present.
  - `scrap.posted` is a registered `DomainEventType` and business_event_outbox emits it in `post_scrap_atomic`.
  - `resolve_default_account` is called for scrap offset (not raw `detail_type` lookup).
- Extend `sod-coverage.test.ts` with scrap actions.

## 6. Out of scope (explicit)

- Manufacturing back-flush integration (`production_orders` scrap yield) — separate BOM/routing epic.
- Insurance claim automation beyond emitting the domain event (webhook handler follow-up).
- Multi-currency revaluation of already-posted scrap — inherits from existing FX revaluation runs.
- Backfilling historic bare `stock_movements` scrap rows into headers. A finance-review query will identify orphans (mirrors the pattern from `docs/audit/2026-05-21-inventory-adjustment-gl.md`).

## 7. Success criteria

- Every scrap event has: header, lines, resolved cost, movement(s), JE, outbox row, audit trail, permission-gated reversal path.
- No scrap ever writes stock without GL, and no scrap ever posts GL without SoD + policy check.
- Zero new account-lookup code — every account resolves through `resolve_default_account`.
- Every UI surface reads through the same `useScrap` hook; no ad-hoc `supabase.from('stock_movements')` scrap queries remain.
