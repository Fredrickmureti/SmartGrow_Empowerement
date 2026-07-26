# Unify /settings/audit-logs — Activity pattern across all three tabs

## Current state (verified)

- **Activity tab** (`src/pages/AuditLogs.tsx`): the canonical pattern.
  - `Table` with columns *When · User · Action · Entity · Name · What happened*.
  - Row click sets `selectedLog`; a single always-mounted `DetailSheet` renders a rich drawer (summary grid, changes diff w/ "Show technical fields" switch, raw JSON, Copy ID / JSON).
  - `DataTablePagination` at the bottom, search box, filter panel.
  - `ClearAuditLogsDialog` (30d / 90d / 1y / all) wired to a purge RPC — seamless deletion with toast.

- **Settings Changes** (`src/components/settings/SettingsAuditLogPanel.tsx`): day-grouped card list with inline `<AuditDiff>` expansion. Already has `ClearAuditLogsDialog` wired to `clear_settings_audit_log`. No drawer, no table, no consistent pagination widget (custom Prev/Next).

- **Legal Orders** (`src/pages/hr/payroll/LegalOrdersAudit.tsx`): per-order timeline UL with inline chevron expansion. No table, no drawer, no clear/delete, no shared pagination. Requires picking one legal order first and shows balance KPIs above the timeline.

Only Activity uses `DetailSheet` + `DataTablePagination` + row-click drawer. That is what to standardize on.

## Goal

Both Settings Changes and Legal Orders tabs adopt the Activity tab's presentation and behavior:

1. Table layout with the same column shape.
2. Row click → single always-mounted `DetailSheet` drawer showing per-entry detail (summary strip + diff/details + raw JSON + Copy ID/JSON).
3. `DataTablePagination` for paging.
4. `ClearAuditLogsDialog` in the header for seamless purge (owner/admin only).
5. Keep each tab's domain-specific bits (Settings scope filter; Legal Orders order picker + balance KPIs) but move them into the same header/filters strip idiom Activity uses.

Non-goals: no changes to the underlying data sources, RPCs, RLS, or business logic. Presentation and interaction only.

## Plan

### 1. Extract a shared `AuditLogTableView` primitive

New file `src/components/audit/AuditLogTableView.tsx`. Pure presentational component so all three tabs render identically.

Props:
```ts
type AuditEntry = {
  id: string;
  occurred_at: string;
  user_label: string | null;         // resolved display name or null
  action: { label: string; tone: string };
  entity_kind: { label: string; raw: string };
  entity_name: string | null;
  summary: string;
  // opaque payload handed back to the drawer renderer
  raw: unknown;
};

interface Props {
  entries: AuditEntry[];
  isLoading: boolean;
  isFetching?: boolean;
  pagination?: PaginationState;
  onPageChange?: (p: number) => void;
  onPageSizeChange?: (n: number) => void;
  onSelect: (entry: AuditEntry) => void;
  emptyTitle?: string;
  emptyHint?: string;
}
```

Responsibilities: `Card` + `Table` + skeleton/empty state + `DataTablePagination`. Mirrors lines 415–495 of `AuditLogs.tsx`.

### 2. Extract a shared `AuditEntryDrawer`

New file `src/components/audit/AuditEntryDrawer.tsx`. Wraps `DetailSheet` with the same header actions (Copy ID / Copy JSON), summary grid, and a `renderBody` slot so each tab can supply its own body (diff table for activity/settings, details grid for legal orders).

Reuses the existing `SummaryItem`, `formatFieldName`, `formatFieldValue`, `diffValues`, `humanize*` helpers from `src/pages/audit-logs/format.ts` and `src/components/audit/auditFormat.ts`.

### 3. Refactor Activity tab

Replace the inline table + `DetailSheet` in `src/pages/AuditLogs.tsx` (`activity` `TabsContent`) with `AuditLogTableView` + `AuditEntryDrawer`. Zero behavior change; this is the reference implementation shrinking to use the shared primitives.

### 4. Rewrite `SettingsAuditLogPanel`

- Adapt the `useSettingsAuditLog` rows into `AuditEntry` (scope → Entity, `setting_key`/`table_name` → Name, humanized action from `old_value`/`new_value` presence).
- Keep the scope `<Select>` and `ClearAuditLogsDialog` in the card header (same slot Activity uses for filters).
- Render `AuditLogTableView` (client-side pagination against the already-fetched list, so no hook change needed).
- Drawer body: reuse `<AuditDiff old={} new={} />` inside `AuditEntryDrawer`, plus SummaryItem strip (Scope, Setting, User, When).

### 5. Rewrite `LegalOrdersAudit`

- Keep the top order picker + "Balance as of" input + KPI cards — this is domain-specific context and stays above the table.
- Map `v_legal_order_audit_timeline` rows to `AuditEntry`:
  - `occurred_at` → When
  - actor lookup via `employees` map → User
  - `entry_kind` → Entity badge (Lifecycle / Audit / Notification / Remittance)
  - `action` humanized → Action
  - `source_table` / `source_row_id` → Name
  - condensed one-liner from `details` → summary
- Render `AuditLogTableView` + `AuditEntryDrawer`. Drawer body reuses the existing `DetailsGrid` (moved into the new drawer file or kept co-located and imported) plus a "View raw JSON" `<details>` block matching Activity.
- **Deletion (new)**: add `ClearAuditLogsDialog` in the header. Since this timeline unions multiple source tables, wire it to a new admin-only RPC `clear_legal_order_audit_timeline(_organization_id, _legal_order_id, _older_than_days)` that purges rows from the writable source tables (audit_logs entries scoped to this order, notification dispatches, lifecycle_events) older than the cutoff. If the user prefers to defer the DB piece, gate the button with `disabled` + tooltip "Available soon" — flag decision needed (see Open questions).

### 6. Shared entry-mapping helpers

Add `src/components/audit/mappers.ts` with three small pure functions: `mapActivityLog`, `mapSettingsChange`, `mapLegalTimelineRow` → `AuditEntry`. Keeps the tabs thin and testable.

### 7. Tests

- Vitest unit tests for the three mappers (`mappers.test.ts`).
- Component smoke test for `AuditLogTableView` (renders rows, fires `onSelect`, empty state).
- Optional: architecture guard asserting all three tabs import `AuditLogTableView` (prevents future drift back to bespoke lists).

## Technical details

- All overlays follow `docs/architecture/OVERLAYS.md`: `DetailSheet` mounted once per tab, `open` bound to `!!selected`.
- No new colors or hardcoded palette — reuse existing `StatusBadge` tones and semantic tokens.
- `DataTablePagination` already ships in the project; Settings & Legal Orders currently do client-side paging on already-fetched data, which is fine as a first cut.
- Domain hooks (`useSettingsAuditLog`, `useLegalOrders`, `v_legal_order_audit_timeline` query) are unchanged.
- Purge RPCs: `clear_audit_logs` (activity) and `clear_settings_audit_log` (settings) already exist. The Legal Orders purge is the only DB-side new work — see Open questions.

## File touch list

```text
NEW  src/components/audit/AuditLogTableView.tsx
NEW  src/components/audit/AuditEntryDrawer.tsx
NEW  src/components/audit/mappers.ts
NEW  src/components/audit/__tests__/mappers.test.ts
EDIT src/pages/AuditLogs.tsx                              (activity tab uses shared primitives)
EDIT src/components/settings/SettingsAuditLogPanel.tsx    (rewrite to table + drawer)
EDIT src/pages/hr/payroll/LegalOrdersAudit.tsx            (timeline → table + drawer; add clear)
MAYBE supabase migration                                  (clear_legal_order_audit_timeline RPC)
```

## Open questions

1. **Legal Orders deletion** — do you want the "Clear logs" button on Legal Orders now (I add the RPC in the same change), or ship the UI unified first and wire deletion once you approve the SQL side?
2. **Legal Orders KPIs + order picker** — keep them above the table (my default), or move them into the drawer / a collapsible? Keeping them above preserves the domain value.
3. Anything you want to *remove* from Activity while I'm in there (e.g. the separate collapsible "Filters" panel), or leave the Activity tab visually identical?
