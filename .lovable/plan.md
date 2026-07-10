
## Audit — what's wrong on `/settings/audit-logs`

Two independent problems, both in `src/pages/AuditLogs.tsx`:

### 1. Presentation is raw/technical
- **Entity type** rendered verbatim from DB (`payroll_run`, `employee_contract`, `pos_transaction_items`) — snake_case, cryptic to non-engineers.
- **Action** shows the past-tense DB verb as-is (`created`/`updated`/`posted`/`reversed`); no human phrasing per entity ("Invoice created", "Payroll run posted").
- **Entity Type filter** dropdown lists raw table identifiers (`payroll_liabilities`, `journal_entry_lines`) — same problem.
- **Changes column** shows the `changes_summary` string when present, `-` otherwise — nothing derived from `old_values`/`new_values`.
- **Detail view** dumps `old_values` and `new_values` as `JSON.stringify(..., null, 2)` inside a `<pre>` — the "JSON data view" the user is complaining about. No field-level diff, no formatting of dates/money/booleans, no hiding of noisy internal columns (`updated_at`, `id`, `organization_id`, `business_id`, `search_vector`, `metadata`).
- **User column** shows `getUserName(user_id)` which returns raw UUID / email prefix for non-members (system triggers, deleted users).
- **IP / user agent** captured on the row but never surfaced.

### 2. Detail view uses a Dialog, not the right-side Sheet
Lines 423–479 use `<Dialog>` / `<DialogContent className="max-w-2xl">`. Project standard (see `docs/architecture/OVERLAYS.md`, `src/design-system/primitives/DetailSheet.tsx`, and the recent Payroll Preview migration) is the right-sliding `DetailSheet` for record peeks.

The `Clear All` `AlertDialog` (lines 207–239) is the correct primitive for a destructive confirmation and stays as-is — AlertDialog ≠ Dialog and is the platform-wide pattern for confirmations. Only the record-detail Dialog moves to a Sheet.

---

## Plan

### A. Humanization layer — new file `src/pages/audit-logs/format.ts`

Pure helpers, no UI:

1. `humanizeEntityType(type: string): string` — snake_case → Title Case with a curated override map for the top ~40 entity types actually written to `audit_logs` (see keys already seen: `invoices`, `bills`, `payments`, `payroll_runs`, `payroll_liabilities`, `payslips`, `journal_entries`, `employees`, `employee_contracts`, `products`, `pos_transactions`, `sales_orders`, `purchase_orders`, `delivery_notes`, `stock_movements`, `contacts`, `users`/`user_roles`, `organizations`, `bank_reconciliation_sessions`, `credit_notes`, `vendor_credit_notes`, `expenses`, `fixed_assets`, `leave_requests`, `attendance`, `estimates`, `proforma_invoices`, …). Fallback: split on `_`, Title Case, singularize trailing `s`.
2. `humanizeAction(action: string): { label: string; tone: StatusBadge tone; icon }` — maps `created|updated|deleted|posted|reversed|paid|approved|rejected|submitted|voided|cancelled|refunded|closed|reopened|sent|received|assigned|unassigned|logged_in|logged_out|exported|imported|…` → readable label + tone (`success` / `info` / `warning` / `danger` / `neutral`). Replaces the current 3-branch `getActionBadge`.
3. `humanizeSentence({ action, entityType, entityName })` — produces the row's Changes fallback: `"Invoice INV-0231 posted"`, `"Employee Jane Doe updated"`, `"Payroll run July 2026 reversed"`. Used when `changes_summary` is null.
4. `formatFieldName(key: string)` — snake_case → readable label for the diff view.
5. `formatFieldValue(key, value)` — formats ISO dates (`format(..., "MMM d, yyyy HH:mm")`), booleans (`Yes`/`No`), numbers that look monetary (keys ending in `_amount|_total|price|cost|balance` → currency), UUIDs (monospace short), objects/arrays (compact one-line, expandable), nulls (`—`).
6. `NOISE_KEYS: Set<string>` — omit `id`, `created_at`, `updated_at`, `organization_id`, `business_id`, `search_vector`, `metadata`, `tsv`, `_row_version` from the diff view by default; expose a "Show technical fields" toggle in the sheet.
7. `diffValues(old, new)` — returns `Array<{ key, before, after, kind: 'added'|'removed'|'changed' }>`, sorted, with noise keys filtered.

### B. Replace the Dialog with `DetailSheet`

In `src/pages/AuditLogs.tsx`:

- Remove `Dialog`, `DialogContent`, `DialogDescription`, `DialogHeader`, `DialogTitle` imports.
- Import `DetailSheet` from `@/design-system` and `StatusBadge`.
- Render `<DetailSheet open={!!selectedLog} onOpenChange={(o) => !o && setSelectedLog(null)} size="lg" title={…} description={…}>` — always-mounted per `docs/architecture/OVERLAYS.md` (drive open via `!!selectedLog`, don't gate the mount on the value).
- Sheet body sections:
  1. **Summary strip** — humanized sentence, action `StatusBadge`, entity type badge, timestamp, actor (name + avatar initial via existing `getDisplayName` util), IP address, user agent (truncated with tooltip).
  2. **Changes** — field-level diff table (before → after) using `diffValues`. Empty state: "No field changes recorded." Toggle "Show technical fields" to reveal noise keys.
  3. **Raw payload** — collapsed `<details>` (closed by default) exposing the original JSON for engineers who still need it. This preserves auditability without leading with JSON.
- Sheet header actions: `Copy log ID`, `Copy JSON`.

### C. Table + filters cleanup (same file)

- Column **Action**: render via `humanizeAction(...).label` inside `StatusBadge` (design-system primitive) instead of the ad-hoc `bg-green-100` Badge.
- Column **Entity**: `humanizeEntityType(log.entity_type)` in the badge; keep raw value in a `title` tooltip.
- Column **Changes**: prefer `log.changes_summary`; if null, fall back to `humanizeSentence(...)` so every row reads as English.
- **Entity Type filter** `<Select>`: show `humanizeEntityType(type)` as the item label, keep `value={type}` so the query still filters on the raw column.
- **Action filter** `<Select>`: same — humanized label, raw value.
- **User column**: keep `getUserName` but wrap through `getDisplayName` (`src/lib/user-display-name.ts`) so email-prefix names don't leak.
- Export CSV: use humanized labels for `Action` and `Entity Type` columns; keep raw values in two extra columns (`action_raw`, `entity_type_raw`) so exports remain machine-parseable.

### D. Nothing else changes

- `useAuditLogsPaginated`, RLS, backend, and the `Clear All` AlertDialog are untouched.
- No new dependencies. `DetailSheet`, `StatusBadge`, `date-fns`, and the existing hooks cover everything.

---

## Technical notes

- Files touched:
  - `src/pages/AuditLogs.tsx` — swap Dialog → DetailSheet, wire humanizers, refactor table cells & filter options, extend CSV export.
  - `src/pages/audit-logs/format.ts` — **new**, pure helpers + tests.
  - `src/pages/audit-logs/__tests__/format.test.ts` — **new**, unit tests for `humanizeEntityType`, `humanizeAction`, `diffValues`, `formatFieldValue`.
- Overlay rules from `docs/architecture/OVERLAYS.md` observed: `DetailSheet` mounted unconditionally, `open` bound to `!!selectedLog`, `onOpenChange` clears state.
- No schema/migration work; entity-type override map is a plain object, so adding new humanized names later is a one-line change.

## Out of scope

- Backfilling `changes_summary` on historic rows.
- Cross-linking `entity_id` to the source record's page (nice-to-have; would need a per-entity-type route resolver — separate follow-up).
- Reworking the `Clear All` AlertDialog (already the correct primitive).
