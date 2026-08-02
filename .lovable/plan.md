# Warehouse Returns (RMA) — Verification Result & Remaining Phases

Authoritative status document. Updated 2026-08-02 after an independent audit of
the previous engineer's claims.

**Currently active phase:** Phase 4b (verification fixes) → then Phase 5.

---

## Phase 1 — Independent verification of prior claims

Every "complete" claim was checked directly against the database and the
codebase. Result: the substrate is genuinely built — this was not a superficial
patch — but four claims are overstated and one is wrong.

| Claim | Verdict | Evidence |
| --- | --- | --- |
| Phase 0 — event catalog repaired | **Partially true** | `topics.ts` declares 13 `warehouse.return.*` topics; the SQL `wms_events_catalog` holds 16 — the three legacy topics `opened`, `inspected`, `dispositioned` are still in SQL and emitted by nothing. Parity is one-directional, so the drift is invisible to the guard. |
| Phase 1 — domain model complete | **True** | `wms_return_orders` (kind, dock/appointment/trailer, carrier, tracking, finance links, disposition summary), `wms_return_lines` (condition, inspection state, disposition, restock/quarantine/scrap buckets, audit columns, `row_version`), `wms_return_photos`, `wms_return_disposition_rules` all exist. |
| Phase 2 — execution RPCs | **Mostly true** | `wms_capture_return_line`, `wms_inspect_return_line`, `wms_disposition_return_line`, `wms_post_return_dispositions`, `wms_close_return` all exist, are `SECURITY DEFINER`, row-version guarded, and emit through `wms_emit_outbox`. The posting RPC genuinely writes `stock_movements`, manages `lot_quarantine`, and spawns `wms_tasks`. **Gap:** no RPC raises `wms_exceptions`, so blocked lines never reach the warehouse exception inbox — a stated Phase 2 deliverable. |
| Phase 3 — feature module | **True with dead code** | All hooks exist, but `useReturnPhotos`, `useUploadReturnPhoto` and `useReturnDispositionRules` have **zero call sites** anywhere in the app. Evidence capture and declarative routing are unreachable. |
| Phase 4 — operations console | **Partially true** | Lane board, lines panel and workspace exist and route correctly. **But** the workspace is a right-hand `Sheet`, not the split-pane console the audit specified; there is no photo panel, no LPN rail, no dock/appointment/trailer surface despite the columns existing; and no handheld/phone operator route exists at all. |
| "No direct client writes" | **False** | `useLinkReturnFinance` performs a raw `supabase.from('wms_return_orders').update({...})` with no `row_version` and no RPC — exactly the pattern the plan forbids, and the reason the guard test never caught it is that no returns-specific guard test was ever written. |

### Consequences for the roadmap

Phase 5 is *not* the right resume point. The correct resume point is a short
**Phase 4b** that closes the verification defects, after which Phase 5 proceeds
as originally scoped.

---

## Phase 4b — Verification fixes (resume here)

1. **Catalog parity, both directions.** Remove or explicitly deprecate the three
   orphan SQL topics; make the guard test assert set equality (SQL ≡ TS) rather
   than subset containment.
2. **Finance linkage via RPC.** Replace the raw update in `useLinkReturnFinance`
   with `wms_link_return_finance(p_return_id, p_row_version, …)`: org-scoped,
   `SECURITY DEFINER`, row-version guarded, outbox-emitting, and validating that
   the referenced `sales_returns` / `purchase_returns` row belongs to the same
   organization.
3. **Exception fan-out.** `wms_post_return_dispositions` raises a
   `wms_exceptions` row (and `warehouse.return.blocked`) for every line it
   refuses to post — missing destination, quarantine without a lot, serial
   mismatch, zero-quantity disposition.
4. **Reachability.** Wire the orphaned photo and disposition-rule hooks into the
   UI (see Phase 5) or delete them; no orphaned modules survive this phase.

## Phase 5 — Hardware integration

- Capture dialog driven by `useWmsScanIntent` + `ProductScanField` +
  `ScanStatusChip`; the product dropdown becomes the fallback, not the primary
  path. Product / lot / serial / LPN resolve through the canonical resolver.
- `useWmsIdentityGate` blocks capture, inspection and disposition on shared
  devices until the operator identifies.
- `ReturnPhotoCapture` component: camera on handhelds, file fallback on desktop,
  writing through `useUploadReturnPhoto`. Photo becomes **mandatory** when
  `condition_code` is `damaged` or `defective`; the disposition RPC enforces it
  server-side rather than trusting the client.
- Labels exclusively via `printWmsLabel` / `PrintLabelButton` using existing
  `QUARANTINE`, `QUALITY_HOLD`, `PUTAWAY`, `LPN` keys plus new
  `wms.label.return_receipt` and `wms.label.disposition` templates seeded in
  SQL. No printer code inside Returns.
- **Mobile operator surface** added to the existing `warehouse-mobile` shell
  (`src/apps/warehouse-mobile`), reusing its IndexedDB offline queue and
  `client_scan_id` idempotency rather than building a second mobile stack:
  scan-first, single-column returns capture and disposition.


## Phase 6 — Document and finance integration

- RMA authorization, return receipt, inspection report, damage report and vendor
  return note generated through the document platform (`document_artifacts` +
  templates), mirroring `dispatchGoodsReceipt`. No ad hoc PDF paths.
- Finance handoff: posted dispositions create / link `sales_returns` or
  `purchase_returns` and the resulting credit note through the Phase 4b RPC.
  Valuation and posting stay in Finance; Warehouse only links.

## Phase 7 — Console completion, guards and ADR

- Replace the Sheet with a true split-pane workspace (resizable: line grid /
  inspection + evidence / event timeline), add the dock–appointment–trailer
  strip, the LPN rail, and aging + SLA counts on the lane board.
- Guard tests: no direct client writes to any `wms_return_*` table; every
  emitted topic declared in both catalogs; disposition persisted on the line,
  never only in the outbox; no printer or barcode import outside the label seam;
  no orphaned returns modules.
- Functional tests for the posting RPC: movement balance, quarantine handling,
  task spawning, close guard, exception raise.
- ADR 0106 documenting the Returns execution model, superseding the header-only
  model in ADR 0101.

---

## Technical notes

- All new writers are `SECURITY DEFINER` RPCs with `p_row_version`; direct state
  UPDATEs from the client stay forbidden and are now enforced by a test.
- Inventory remains the stock authority: the only inventory effect path is
  `stock_movements` inserts inside `wms_post_return_dispositions`.
- Migrations remain additive; in-flight returns are unaffected.
- Each phase leaves `/warehouse-app/returns` functional.
