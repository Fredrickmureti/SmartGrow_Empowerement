
# Enterprise Hardware Operations Workspace — Engineering Report & Redesign Plan

## 1. Current information architecture — assessment

### `/platform/hardware/print-queue` (`HardwarePrintQueue.tsx`)
- Single flat table over `print_jobs`. Every column is a raw DB field.
- Primary-surface fields include: `doc_type` enum (`legal_recipient_statement`), `intent`/`format`/`transport` enums (`receipt_printer`, `pdf-browser`), `correlation_id` UUID, `doc_id` UUID, `last_error` (full stack), `parent_job_id`.
- No printer name, no requester name, no document number. Just IDs.
- Filters: status, doc_type (raw enum values), free-text on IDs. No date range, no printer/branch/user filter, no saved views, hard cap of 500.

### `/platform/hardware/diagnostics` (`HardwareDiagnostics.tsx`)
- One 720-line page rendering **7 stacked cards** with no navigation: DLQ, Runtime, Registries, Agent, Capabilities, Runtime decisions (25 rows), Recent commands (50 rows) — plus per-role health chips inside the last card.
- Rows show `role` / `op` / `transport` as raw code identifiers (`receipt_printer`, `escpos_label`, `electron-bypass`).
- Recent commands polls every 10 s and keeps growing vertically; no pagination, no drill-down, no date range.
- "Copy diagnostics" dumps a JSON blob — clearly built for engineers, not operators.

**Verdict:** both pages are developer log viewers surfaced under an operator route. They optimise for "give me every field" instead of "what needs my attention?".

## 2. Enterprise research findings (patterns common to SAP Output Management, Oracle Retail Xstore, MS Dynamics 365 Commerce Hardware Station, Odoo IoT, Square/Shopify/Toast POS, Zebra Printer Profile Manager, Epson Device Admin)

Recurring principles:

1. **Status-first summary strip** at the top: today's counts by outcome (succeeded / failed / retrying / offline printers) — the operator's "is anything on fire?" glance.
2. **Business identity, not technical identity, in the primary column.** "Invoice INV-2026-0143 → Front Counter Receipt · Alice K." — never a UUID on the surface.
3. **Progressive disclosure**: a click opens a **side drawer / detail panel** with the technical payload (correlation id, transport, raw error, retry history, hardware command id, payload hash). Row stays clean.
4. **Faceted filtering + saved views**: date range, printer, workstation, branch, status, document class. Views persist per user.
5. **Grouped diagnostics workspace**, not one endless scroll — a left-rail or tabbed layout: Overview · Devices & health · Activity · Errors & DLQ · Runtime · Support bundle.
6. **Per-printer health cards** (queue depth, last success, error rate, p50 latency, "offline since") instead of per-role code chips.
7. **Alerts and actions surfaced next to the problem** (Retry, Cancel, Mark reviewed, Open printer, Download support bundle). Read-only technical tables live under a "Raw" / "Support engineer" toggle.
8. **Log surfaces are searchable and paginated**, never infinite lists. Enterprises page 25/50/100 with cursor/date navigation.

## 3. Human-readable information strategy

Introduce a small display-mapping layer, colocated with the hardware app:

- `src/apps/platform/hardware/lib/humanize.ts` — pure functions:
  - `docTypeLabel(docType)` → `"Invoice"`, `"Receipt"`, `"Statement to legal recipient"`, `"Delivery note"`, `"Payslip"`, …
  - `intentLabel(intent)` → `"Customer copy"`, `"Merchant copy"`, `"Shelf label"`, …
  - `formatLabel(format)` → `"PDF"`, `"ESC/POS"`, `"ZPL"`, `"EPL"`.
  - `transportLabel(transport)` → `"Browser print dialog"`, `"USB (Electron)"`, `"Network 9100"`, `"IoT agent"`, `"CUPS"`.
  - `statusLabel(status)` → `"Queued"`, `"Sent to printer"`, `"Printed"`, `"Failed"`, `"Cancelled"`.
  - `runtimeReasonLabel(reason)` → already partially done, extend.
  - `errorSummary(lastError)` → strip stack, pick the human sentence; classify into `{offline, out-of-paper, driver-missing, auth, unknown}`.
- All raw enum keys stay accessible via `.title` tooltips and in the detail drawer.

For business identity resolution, add `useDocumentDisplay(docType, docId)`:
- Small union-typed resolver that batches lookups per doc_type (`invoices.invoice_number + contact_name`, `delivery_notes.dn_number`, `payslips.employee_name + period`, `legal_recipients.name`). Cached via react-query, 60 s stale.
- Falls back to `docType humanized + short id (last 8)` when the source record is deleted or user lacks scope.

Requester name: join `requested_by` → `profiles.display_name`. Also batched.

Printer/workstation name: `printer_profile_id` → `device_assignments.label` (or the human label already stored). Batched.

## 4. Technical information strategy

- Detail drawer shows the raw fields grouped: **Job identifiers** (correlation, hw_command_id, parent), **Timeline** (requested → sent → acked/failed with deltas), **Transport & driver**, **Raw error** with copy button, **Retry history** (attempt_count + `last_error` snapshots).
- A single "Support engineer view" toggle at page level shows a `Correlation` column in the table and unhides the JSON copy button.

## 5. Proposed workspace layout

### `/platform/hardware/print-queue` — Print activity

```text
┌───────────────────────────────────────────────────────────────────────────┐
│ Print activity   [Today ▾]  [All printers ▾]  [All statuses ▾]  ⚙ Views  │
├───────────────────────────────────────────────────────────────────────────┤
│  Printed 1 284    Failed 12 ⚠    Retrying 3    Offline printers 1        │
├───────────────────────────────────────────────────────────────────────────┤
│ Time · Document · Requested by · Destination · Status · Duration · ⋯     │
│ 14:02  Invoice INV-2026-0143     Alice K.   Front Counter    Printed  1.2s│
│ 14:01  Receipt #4471             POS-01     Kitchen Thermal  Failed ⚠ 3.8s│  ← click opens drawer
│ …                                                                          │
│                                              25 / 50 / 100  ‹ 1 2 3 4 ›   │
└───────────────────────────────────────────────────────────────────────────┘
```

- Top strip: KPI cards (Printed, Failed, Retrying, Offline printers) for the selected range (default: Today).
- Filters: date range, printer, branch, status, document class, requester, free-text.
- Table columns: **Time · Document · Requested by · Destination · Status · Duration · ⋯ (drawer)**.
- Row expansion → side drawer with Overview / Timeline / Payload & transport / Raw error / History tabs; per-row actions: Retry, Cancel, Open printer, Copy correlation.
- Parent/children (copies) collapsed by default into a "3 copies" pill; expand inline.
- Pagination + cursor over `requested_at`; server-side ordering. 500-row cap removed.
- Saved views: persist filter state in `report_saved_views` (existing table) keyed by `view_kind = 'hardware.print_queue'`.

### `/platform/hardware/diagnostics` — Diagnostics workspace

Restructure into a **tabbed sub-workspace** with a persistent header (environment badge + refresh + Support-bundle download):

```text
Diagnostics
[ Overview | Devices & health | Activity | Errors & DLQ | Runtime | Support ]
```

- **Overview** — high-signal cards only: environment (Electron / Browser + preload build), agent reachability, canonical vs cache row parity, DLQ size, printers currently offline, per-printer health top 5.
- **Devices & health** — one card per configured printer/device: label, transport, driver, last success/failure, error rate 1h/24h, queue depth, p50 latency, actions (test print, open in registry). Replaces raw "per-role chips" with named printers.
- **Activity** — the full paginated `hardware_exec_log` with the same human-labelling and drawer pattern as Print activity; filters: role → **device**, op, result, date range.
- **Errors & DLQ** — the DLQ card plus recent failures grouped by root cause (`offline`, `driver-missing`, `auth`, `unknown`), each with a "how to fix" hint and jump-to-device.
- **Runtime** — current Runtime, Registries, Agent, Capabilities cards (technical detail belongs here, off the operator's first screen). Runtime-decisions ring stays here.
- **Support** — copy diagnostics JSON, download support bundle, links to `HARDWARE_RUNTIME.md`, "Reset hydrator", contact-support prompt.

Tabs use URL search params (`?tab=devices`) so links from alerts land users on the right pane.

## 6. Navigation, filters, saved views

- Date range: presets (Today, Last 24 h, Last 7 days, Custom) — default Today.
- Printer filter: driven by `device_assignments` rows for the current business/branch, showing human label.
- Branch filter: from `useBranches()`.
- Status filter: business-labelled (`Queued`, `Sent`, `Printed`, `Failed`, `Cancelled`).
- Free-text: matches document number, requester name, printer name, correlation id (advanced/engineer mode).
- Saved views: persisted per user via existing `report_saved_views` (`view_kind` `hardware.print_queue` / `hardware.activity`).

## 7. Legacy cleanup

- Delete the 500-row hard cap and the current flat table body in `HardwarePrintQueue.tsx`.
- Remove the "Copy diagnostics" button from the diagnostics header and move it into the **Support** tab (it is a support tool, not an operator action).
- Move raw enum rendering out of the primary tables; replace with human labels + tooltip.
- Retire the "per-role health" chip strip in favour of the **Devices & health** tab. Underlying computation is preserved and reused.
- Retire the raw "Recent hardware commands" table from the Overview surface; it lives under **Activity** with human labels.
- Keep `DeadLetterQueueCard` but move it into the **Errors & DLQ** tab.
- No component is deleted outright — every current data source (`hardware_exec_log`, `print_jobs`, `getRecentRuntimeReasons`, `HydratorStatus`, agent status) is reused; only presentation changes.

## 8. Migration plan (no regressions)

Small, sequenced PR-sized steps. Each step keeps the current pages functional.

**Step 1 — Presentation layer (pure, no route change).**
- Add `src/apps/platform/hardware/lib/humanize.ts` (pure enum → label maps).
- Add `useDocumentDisplay`, `useRequesterDisplay`, `usePrinterDisplay` hooks (batched react-query resolvers, cached 60 s).
- Add `src/apps/platform/hardware/components/JobDetailDrawer.tsx` and `PrintKpiStrip.tsx`.

**Step 2 — Print Queue redesign.**
- Rewrite `HardwarePrintQueue.tsx` around: KPI strip → faceted filter bar → paginated table (human columns) → row drawer.
- Server-side pagination via `requested_at` cursor; page sizes 25/50/100.
- Saved views wired to `report_saved_views` (`view_kind='hardware.print_queue'`).
- Copy retention: parent/child fan-out is now a "N copies" pill in the parent row, expandable inline.

**Step 3 — Diagnostics workspace split.**
- Introduce tab shell (`Tabs` from shadcn) with URL-synced tab.
- Split existing cards into their new tabs (Overview, Devices & health, Activity, Errors & DLQ, Runtime, Support). Each moved card is imported unchanged first, then internally refactored to use human labels.
- Build **Devices & health** by joining `hardware_exec_log` aggregates (already computed in `health` memo) with `device_assignments` (label, transport, driver) so each card is a named device, not a role code.
- Move Runtime decisions + Recent commands into **Activity**; wire the same drawer + humanize layer as Print Queue.

**Step 4 — Cleanup + guards.**
- Remove the raw "Copy diagnostics" button from the page header (kept inside Support tab).
- Delete unused code paths (500-row cap, `RUNTIME_REASON_LABELS` duplicate).
- Add an architecture test `hardware-operator-workspace-humanized.test.ts` asserting:
  - `HardwarePrintQueue.tsx` does not render raw `doc_type`/`intent`/`transport` identifiers as leaf text nodes (must go through `humanize.ts`).
  - `HardwareDiagnostics.tsx` mounts a `Tabs` root and does not render more than one primary table at the top level.
  - No raw `correlation_id` in the primary Print Queue table body (allowed only inside the drawer / engineer mode).

**Step 5 — Docs.**
- Add ADR `docs/architecture/decisions/0100-hardware-operator-workspace.md` capturing the operator-vs-engineer split and the humanize layer as the canonical presentation contract.
- Update `mem/features/hardware-platform.md` "Platform surface" bullet to reference the tabbed diagnostics workspace and the humanize layer as required for any new operator screen.

## 9. Technical details (engineer-facing)

- **Data model:** no schema changes required. All redesign is presentational + query composition. `print_jobs`, `hardware_exec_log`, `device_assignments`, `profiles`, and the per-document tables already carry every field needed.
- **Query strategy:** replace one-shot `.select('*').limit(500)` with keyset pagination `.order('requested_at', {ascending:false}).range(offset, offset+size-1)` plus a lightweight `count(*)` per filter change (cached).
- **Batch resolvers:** `useDocumentDisplay(rows)` groups `doc_id`s by `doc_type`, issues one query per type, returns a `Map<doc_id, {label, subLabel}>`. Same pattern for requester (`profiles`) and printer (`device_assignments`).
- **State persistence:** filter/tab state → URL search params; saved views → `report_saved_views` (existing).
- **No new tables, no new RPCs, no new edge functions.** No RLS changes.
- **Guard files touched:** add one new architecture test; existing hardware guards untouched.
