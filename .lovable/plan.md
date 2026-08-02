# Warehouse Returns (RMA) — Architecture Audit & Enterprise Rebuild

Authoritative status document. Update after every completed implementation.

**Currently active phase:** Phase 4 complete → **Phase 5 (Hardware integration) is next.**

---

## Status summary

| Phase | Scope | Status |
| --- | --- | --- |
| 0 | Event catalog repair | Complete, verified |
| 1 | Domain model completion | Complete, verified |
| 2 | Server-side execution RPCs | Complete, verified |
| 3 | Returns feature module (hooks + model) | Complete, verified |
| 4 | Returns operations console (UI) | Complete, verified |
| 5 | Hardware integration (scan / camera / labels) | Pending — next |
| 6 | Document + finance integration | Pending |
| 7 | Guard tests + ADR documentation | Pending |

---

## Completed and verified

### Phase 0 — Event catalog repair
- Registered the lifecycle topics actually emitted by `wms_transition_return`
  (`draft`, `authorized`, `in_transit`, `received`, `inspecting`, `disposed`,
  `closed`, `cancelled`) plus line-level execution topics (`line_captured`,
  `line_inspected`, `line_dispositioned`, `dispositions_posted`, `blocked`).
- Deprecated declared-but-never-emitted legacy topics (`opened`, `inspected`,
  `dispositioned`).
- `src/features/warehouse/events/topics.ts` synchronized with the database.
- Verified by `src/test/architecture/wms-topic-catalog-sync.test.ts` (passing).

### Phase 1 — Domain model completion
- `wms_return_orders`: `return_kind`, appointment / dock / trailer links,
  carrier + tracking reference, finance document links (`finance_doc_type`,
  `finance_doc_id`, `credit_note_id`), `disposition_summary`.
- `wms_return_lines`: `condition_code`, `inspection_state`, `qc_inspection_id`,
  `disposition`, `destination_location_id`, restock / quarantine / scrap
  buckets, capture / inspection / disposition / posting audit columns,
  `blocked_reason`, `photo_count`, `row_version`.
- New `wms_return_photos` (condition evidence) and
  `wms_return_disposition_rules` (declarative routing).
- RLS + grants applied in the same migrations as the table creation.

### Phase 2 — Server-side execution engine
All `SECURITY DEFINER`, org-scoped, `row_version` guarded, outbox emitting:
- `wms_capture_return_line` — idempotent scan-safe capture (`client_scan_id`).
- `wms_inspect_return_line` — creates / links `wms_qc_inspections`
  (`source_doc_type = 'sales_return'`).
- `wms_disposition_return_line` — rule-matched or manual disposition split,
  destination-location validation.
- `wms_post_return_dispositions` — the single inventory-effect path: writes
  `stock_movements` (`return_in`, `quarantine_hold`, `scrap`), manages
  `lot_quarantine`, spawns follow-up `wms_tasks` (putaway / scrap move /
  vendor return).
- `wms_close_return` — terminal guard; refuses closure while lines are
  unposted.

### Phase 3 — Returns feature module
`src/features/warehouse/returns/`
- `returnsModel.ts` — shared types, condition / disposition vocabularies,
  state tones, and the `returnLane()` derivation (header state + line facts).
- `useReturnOrders.ts` — header list / single read, create, FSM transition,
  close, finance linkage.
- `useReturnLines.ts` — line reads (single + bulk for lane derivation),
  capture, inspect, disposition, post.
- `useReturnPhotos.ts` — storage upload + pointer row + photo-count sync.
- `useReturnDispositionRules.ts` — rule CRUD for the routing table.

### Phase 4 — Returns operations console
- `ReturnsLaneBoard.tsx` — tower lanes (Expected, At dock, Unloading, Awaiting
  inspection / disposition / posting / finance, Blocked) with click-to-filter.
- `ReturnLinesPanel.tsx` — line-grain capture, inspection and disposition
  dialogs; every action is an RPC round-trip with `row_version`; posted lines
  become immutable.
- `ReturnWorkspace.tsx` — split-pane workspace: header FSM actions, quantity
  rollup, post-dispositions gate, server-guarded close, cancel, and the
  `OutboxTimeline` event trail.
- `src/pages/warehouse/ReturnOrders.tsx` rewritten as the console; routed at
  `warehouse/returns`.
- Verified: `tsgo --noEmit` clean; no direct client writes to `state`,
  quantities, dispositions or inspection state.

---

## Pending work

### Phase 5 — Hardware integration (next)
- Bind `useWmsScanIntent` + `ScanStatusChip` to the capture dialog so product,
  lot, serial and LPN scans populate the form without keyboard entry.
- Enforce `useWmsIdentityGate` before capture / disposition on shared devices.
- Camera capture wired into `useUploadReturnPhoto` for damage evidence, with a
  per-line photo requirement when `condition_code` is damaged or defective.
- Return label printing via `PrintLabelButton` / `WMS_LABEL_KEY` for
  quarantine, scrap and vendor-return cartons.

### Phase 6 — Document and finance integration
- Return receipt / RMA acknowledgement document through the document platform
  (mirror `dispatchGoodsReceipt`).
- Credit note / vendor debit note creation from posted dispositions, linked via
  `useLinkReturnFinance`.

### Phase 7 — Guard tests and documentation
- Architecture guards: no direct table writes to return line quantities or
  state from client code; every emitted return topic declared in the catalog.
- Functional tests for the posting RPC (movement balance, task spawning,
  close guard).
- ADR for the returns subsystem, superseding ADR 0101's header-only model.

---

## Instructions for the next agent

1. **Verify Phase 4 before writing new code.**
   - Run `bunx tsgo --noEmit` and the architecture tests.
   - Open `warehouse/returns` in the preview: confirm the lane board counts,
     that selecting a row opens the workspace, and that capture → inspect →
     disposition → post → close works end to end against a test return.
   - Confirm no component writes `wms_return_orders.state` or
     `wms_return_lines` quantities directly; all mutations must go through the
     hooks in `src/features/warehouse/returns/`.
2. **Then resume at Phase 5**, in the order listed above (scan intent →
   identity gate → camera evidence → labels). Do not start Phase 6 until
   Phase 5 is coherent and production-ready.
3. Keep execution chronological. No unrelated areas, no partially wired
   features, no orphaned UI without a server path behind it.
4. Update this file immediately after each completed implementation.

---

## Out-of-band fix — App switcher coverage (2026-08-02)

Not part of the returns roadmap; logged for traceability.

- `getAppGroups()` in `src/lib/apps/registry.ts` used hardcoded per-category id
  allow-lists, so **Warehouse** and **Talent** never appeared in the app
  switcher, and **Reports** was missing from `APP_REGISTRY` altogether
  (its "Analytics" group always resolved empty). On mobile the switcher is the
  only way to change apps (the AppRail is desktop-only), so those apps were
  unreachable there.
- Fixes: registered `REPORTS_APP` in `APP_REGISTRY`; added `warehouse` to
  Operations and `talent` to Human Resources; made grouping exhaustive by
  construction with an "Other apps" catch-all so future apps can never be
  silently hidden.
- Guard: `src/test/architecture/app-switcher-coverage.test.ts` asserts every
  registered app (except the single-purpose `me` shell) is reachable from
  `getAppGroups()`, with no duplicates and no empty groups.

Returns roadmap status is unchanged: Phases 0–4 done, **Phase 5 (hardware
integration) is next** — see the instructions above.
