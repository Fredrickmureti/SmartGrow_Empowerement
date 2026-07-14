
# Inventory Replenishment — Validation Report

Scope of verification: the code shipped by the previous agent under
`src/pages/ReplenishmentLog.tsx`, `src/components/inventory/RecommendationDrawer.tsx`,
`src/hooks/useProcurementRecommendations.ts`, and the two migrations
`20260714110953_*` (planning engine) and `20260714114201_*` (lifecycle RPCs).

## 1. Verification of the final claim

Claim: *"Wired the recommendations table to the new drawer, added bulk‑merge action and selection checkboxes, removed the legacy 'Why' dialog."*

| Item | Status | Evidence |
| --- | --- | --- |
| Table → drawer wiring | Verified | `ReplenishmentLog.tsx` L332, `<RecommendationDrawer>` mounted L551‑555. |
| Selection checkboxes | Verified | L334‑346, `selected: Set<string>` state L92. |
| Bulk merge action | Verified (with caveats — see §3) | L262‑285 uses `mergeRecs.mutateAsync`. |
| Legacy "Why" dialog removed | Verified | `rg 'WhyDialog\|WhyModal\|ReplenishmentWhy'` returns 0 hits; no orphaned import. |
| No orphaned code / unused hooks | Partial | `useProcurementRecommendations` still exports `assign` — never called from any UI (dead surface). Several `(r as any).edited_qty` / `(r as any).status` casts even though both fields are on the typed interface. |
| No regressions | Not fully verifiable without runtime — see §4. |

Conclusion: the four headline items are in the codebase, but the feature is
**not** at the "enterprise planning engine" bar the brief demands.

## 2. What the subsystem does model correctly

- Deterministic recommendation math on the server (safety + velocity/7 × lead − available − incoming, pack/MOQ rounded) — matches Odoo/SAP MRP baseline. Verified in engine unit tests (`src/lib/replenishment/__tests__/engine.test.ts`).
- Full lifecycle status enum (`open / in_review / approved / snoozed / dismissed / actioned / executing / fulfilled / cancelled / merged`) plus an append-only `procurement_recommendation_events` audit trail.
- Server-side lifecycle RPCs (`snooze / assign / edit_qty / convert_to_po / convert_to_transfer / merge`) are `SECURITY DEFINER` and re-check `user_can_access_business`.
- Auto-fulfill / auto-reopen triggers on the linked PO and transfer (`sync_recommendation_from_po` etc.) — replenishment closes itself when the sourcing document completes or is cancelled, which is the correct enterprise contract.

These parts are production-shaped and should not be reworked.

## 3. Gaps — planner workflow is incomplete

### 3.1 Missing lifecycle actions in the UI (RPCs exist server-side)

- **Approve / reject** (`status: in_review → approved / dismissed`) — the state machine and the events table already support it, but the drawer only exposes Snooze / Dismiss and direct "Create PO". There is no queue view for "pending approval".
- **Assign** — `assign` mutation is exported by the hook but not wired anywhere. Planner ownership is invisible.
- **Bulk actions** — only merge is exposed. Enterprise planners need bulk approve / dismiss / snooze / convert‑to‑PO by vendor.
- **Manufacturing** — schema has `linked_mo_id` and `suggested_source: manufacture`, but there is no `convert_recommendation_to_mo` RPC or UI. Any recommendation with `suggested_source='manufacture'` is a dead-end today.

### 3.2 Convert‑to‑PO UX regressions vs. the RPC contract

- The RPC accepts `p_vendor_id`, but the drawer always sends `null`. If the preferred vendor is missing, the button is simply disabled with a hint to "edit the reorder rule". A planner cannot override the vendor from the drawer even though the backend supports it.
- No vendor pricelist / lead‑time preview.
- No "add to existing draft PO for this vendor" — every conversion creates a new draft. The main brief calls this out ("Linked to existing Purchase Orders").

### 3.3 Convert‑to‑transfer is blind

- Warehouse selects list every warehouse without any stock indication. Planner picks source blind; no `on_hand at source ≥ qty` validation, no "source warehouses with surplus" suggestion. The RPC can and should return a "recommended source" hint.

### 3.4 Merge action UX

- Button label says "Merge (same product + vendor)" but nothing client-side validates that the current selection satisfies it. The user only learns via a toast when the RPC raises. Pre-flight the constraint client-side and disable the button with an inline reason.
- After a merge, `edited_qty` is discarded (`edited_qty = NULL` at L433) — override reasons on individual recs vanish from the target row (they remain in the audit trail, so this is auditable, but the drawer's "Overridden *" marker will disappear silently). Worth surfacing a note in the merge event payload.
- Merge is only allowed for `open / in_review / approved / snoozed` — good — but the drawer doesn't tell the user why a specific selection is ineligible.

### 3.5 Runs tab is a stub

- Shows only counters. No drill-in: cannot see which recommendations came out of a run, cannot see per-run errors, cannot re-run a scope, cannot see run duration.
- Hardcoded `.limit(20)` in `runsQuery`. No pagination.

### 3.6 Filtering, sorting, pagination

- Recommendations table filters only on urgency + free-text. Missing: status, assignee, vendor, warehouse, source-type (`buy/transfer/manufacture`), needed_by range, aging bucket.
- Hard `.limit(500)` on the client query. Silent truncation once a mid-size retailer runs planning across branches — dangerous for a "planning engine".
- No column sort; the single order is by urgency then created_at. Planners typically pivot by needed_by, cover days, spend.
- `searchQuery` and `statusFilter` are single state variables shared across the "Recommendations", "Runs", and "Auto‑PO log" tabs → filters bleed across tabs.

### 3.7 KPIs / workspace narrative

- Five KPI cards but nothing answering the questions the brief explicitly requires: *"Which recommendations require approval?", "Which shortages remain unresolved?", "Which purchase orders already solve the problem?"* No "assigned to me", "awaiting approval", "aging > N days" tile.
- No inline "why" narrative on the row — the drawer's Overview shows raw fields; there is no human sentence like "Will stock out in 4d; 28d velocity 21/wk; incoming 0; needed by …". The prompt explicitly asks for explainability.

## 4. Code quality issues (senior-review bar)

- **State model** — `selected` is a `Set` in `useState`. Selected IDs are not pruned when the filter changes; a planner can filter, select rows, change the filter, and merge rows they no longer see. Should intersect with `filteredRecs.map(r => r.id)` before enabling merge.
- **Row interaction accessibility** — `<TableRow onClick=…>` with no `role="button"`, `tabIndex`, or keyboard handler. Screen-reader / keyboard users cannot open the drawer. `<Checkbox>` has no `aria-label`.
- **Type safety** — `(supabase as any)` everywhere plus `(r as any).edited_qty / (r as any).status` even though those keys exist on `ProcurementRecommendation`. Suggests generated Supabase types are stale; a regeneration + removing the casts is a same-turn cleanup.
- **Optimistic updates missing** — snooze / dismiss / setStatus have zero optimistic feedback; the row disappears only after invalidation, which is jarring under 500 rows.
- **Toast error rendering** — `toast.error(normalizeError(e).message)` is correct but relies on the RPC's raw error text ("Recommendations must share the same business, product and preferred vendor"). Users see a wall of SQL-flavored English. Wrap the well-known RPC error codes into UX-friendly messages.
- **Runs polling** — no realtime channel and no auto-refresh while a run is in status `running`. The UI shows a stale "Running" badge until manual refresh.
- **Debouncing** — `searchQuery` re-filters and re-renders 500 rows on every keystroke, no `useDeferredValue` / debounce.
- **Two responsibilities per page** — "Inventory Planning" and legacy "Auto-PO log" share one route, one state, one search box. Consider extracting the log to `/inventory-app/replenishment/log` as an archival view.
- **Dead export** — `useProcurementRecommendations().assign` has no caller. Either wire the UI or remove.
- **`packagingRollup.ts` still exposes legacy names** — unrelated, but a similar "kept for backward compat" pattern the team should audit before the next release.

## 5. Data / correctness observations

- Planning writes but the workspace does not show how the client cache reacts to the new run — `runPlanning.onSuccess` invalidates queries, but there is no post-run summary state (which recs are new vs. carried over vs. auto-closed). Add `runs_delta` counters or a "since last run" filter.
- `procurement_recommendations` are filtered by `OPEN_STATUSES` (`open / in_review / approved / snoozed`). Anything moved to `actioned / executing / fulfilled / cancelled / merged / dismissed` vanishes from the workspace. There is no "history" tab per product to see the last N recommendations — planners want that for auditing repeat stock-outs.
- `needed_by` is derived by the engine but never used for sorting, filtering, or KPIs.
- `explanation` JSON is shown as a raw key/value grid inside `<details>`. Not consumable by a non‑technical planner.

## 6. Recommended follow‑up (in priority order)

Small, high‑leverage fixes (can be shipped in one iteration):

1. **Approve / reject actions in the drawer**, plus an "Awaiting approval" filter/tile. Wire `setStatus` for `in_review → approved / dismissed` and emit the audit event.
2. **Assignment UX**: assignee combobox in the drawer + `Assigned to me` KPI. Consumes existing `assign` RPC.
3. **Pre‑flight merge validation** on the client (same business + product + vendor) with an inline reason when ineligible.
4. **Vendor override + attach‑to‑existing‑draft PO** in the convert‑to‑PO section. RPC already accepts `p_vendor_id`.
5. **Accessibility pass**: row keyboard/role, checkbox `aria-label`, focus styling for selected rows.
6. **Deduplicate per‑tab state** (separate `searchQuery`/`statusFilter` for the log tab).
7. **Drop `(as any)` casts** — regenerate Supabase types and clean the row rendering.
8. **Optimistic updates + toast copy polish** for snooze / dismiss / edit qty.

Medium (next iteration):

9. **Runs drill‑in** page: recommendations produced by a run, timings, errors, re‑run scope.
10. **Manufacturing conversion** (`convert_recommendation_to_mo`) — closes the `suggested_source='manufacture'` dead end.
11. **Suggested source warehouse** on the transfer flow, driven by warehouse stock + lead time.
12. **Server-side pagination / cursor** in `procurement_recommendations` query; virtualize the table.
13. **Filter set**: status, assignee, vendor, warehouse, source type, needed_by range, aging bucket. Persist as saved views.
14. **Human "why" narrative** in the drawer built from the explanation payload.

Larger (architectural — flag for ADR discussion):

15. **Approval workflow integration** with `approval_requests / approval_workflows` (already present in the schema) instead of a bespoke `in_review → approved` state.
16. **Retire the Auto‑PO log tab** or move to a "Legacy activity" archival route once the new engine is fully adopted.
17. **Forecast tie‑in**: expose the forecast contribution driving `needed_by` and let planners flip scenarios (safety +N days, promo uplift, etc.).
18. **Realtime channel** on `replenishment_runs` and `procurement_recommendations` so multi-planner workspaces converge without manual refresh.

## 7. Definition of "done" this report proposes

The feature is production-ready once, in the Inventory Planning workspace,
a planner can — without leaving the page and without SQL knowledge:

- see the shortages, why they exist, and when they will hit;
- filter and slice recommendations by every dimension listed in §3.6;
- take every lifecycle action the schema supports (approve, reject, assign, snooze, dismiss, edit, merge, convert to PO / transfer / MO), in bulk, with pre‑flight validation;
- follow a recommendation into the PO / transfer / MO it created, and back again;
- inspect a planning run's outputs and errors.

The current implementation satisfies roughly the first bullet and half of the third. Everything above is what closes the gap between "dashboard displaying inventory metrics" and "enterprise planning engine".

### Technical annex

- Files reviewed:
  `src/pages/ReplenishmentLog.tsx`,
  `src/components/inventory/RecommendationDrawer.tsx`,
  `src/hooks/useProcurementRecommendations.ts`,
  `src/hooks/useReplenishmentLogs.ts`,
  `src/lib/replenishment/engine.ts`,
  migrations `20260714110953_*` and `20260714114201_*`,
  `src/apps/inventory/{nav.ts,routes.tsx}`.
- No runtime execution / Playwright reproduction was performed; all findings are static. If you want, I can drive the workspace with Playwright in build mode to confirm the accessibility, filter‑bleed, and stale‑runs observations.
- Next step: approve this report (or trim the follow-up list) and I will implement §6 items 1–8 in a single build pass.
