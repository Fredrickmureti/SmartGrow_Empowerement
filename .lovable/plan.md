# Warehouse Returns (RMA) — Authoritative Project Plan & Status

Last updated: 2026-08-02 (end of Phase 6.1–6.2)
**Currently active phase:** Phase 6 — Document & finance integration (core delivered; remainder listed below)
**Next milestone:** finish Phase 6 residuals, then Phase 7 (console completion, guards, ADR 0106)

---

## Status summary

| Phase | Scope | Status |
| --- | --- | --- |
| 0 | Event catalog | ✅ Complete & verified (bidirectional parity guard) |
| 1 | Domain model (`wms_return_orders/lines/photos/disposition_rules`) | ✅ Complete & verified |
| 2 | Execution RPCs (capture / inspect / disposition / post / close) | ✅ Complete & verified |
| 3 | Feature module (hooks) | ✅ Complete; no orphan hooks remain |
| 4 | Operations console (lane board, lines panel, workspace) | ⚠️ Functional; still a Sheet, not a split pane (Phase 7) |
| 4b | Verification fixes | ✅ Complete & verified |
| 5 | Hardware integration (scan intent, identity gate, labels, mobile) | ✅ Complete & verified |
| 6 | Document & finance integration | 🟡 Active — 6.1/6.2 delivered, 6.3/6.4 pending |
| 7 | Console completion, guards, ADR 0106 | ⛔ Not started |

---

## Phase 4b — Verification fixes (complete)

- Bidirectional topic parity: `WMS_DEPRECATED_TOPICS` + SQL↔TS set guard, no-resurrection check.
- `wms_link_return_finance` RPC replaces the raw client update in `useLinkReturnFinance`
  (access check, `row_version` guard, doc-type whitelist, cancelled-return block,
  `warehouse.return.finance_linked` emitted and catalogued).
- Exception fan-out re-audited: `wms_post_return_dispositions` already raises through
  `wms_raise_exception` and emits `warehouse.return.blocked`.
- Orphans wired: `ReturnPhotoStrip` (inspection dialog), `ReturnRuleHint` (disposition dialog).

## Phase 5 — Hardware integration (complete)

- `returns.item` / `returns.lpn` added to `WmsScanIntent`; RMA capture routes through the
  platform `scanRouter` and GS1 pre-parse.
- `WMS_LABEL_KEY.RETURN_RECEIPT` / `DISPOSITION` registered and seeded in SQL
  (`wms_seed_default_label_templates`); label-coverage guard passes.
- `wms_replay_guarded_call` whitelists `wms_capture_return_line`, `wms_inspect_return_line`,
  `wms_disposition_return_line` — handheld actions are offline-queueable and deduped on
  `(device_id, client_scan_id)`.
- Server rule: damaged/defective lines cannot be dispositioned without a photo; the desktop
  disposition dialog mirrors the rule and blocks Apply before the RPC errors.
- Mobile: `/wm/returns` list + `/wm/returns/:id` scan → qty → condition loop using
  `ProductScanField` and `enqueue()`, plus a home tile and return-receipt label print.

## Phase 6 — Document & finance integration (ACTIVE)

### Delivered and verified (6.1 – 6.2)

- **Document kinds seeded** (migration): `wms.rma_authorization`, `wms.return_receipt`,
  `wms.inspection_report`, `wms.damage_report` in `document_kinds` (domain `wms`).
- **Snapshot builder** `src/services/documents/snapshots/wmsReturn.ts` — one builder, four lenses;
  quantity-only (all money fields hard zero, valuation stays in Finance); damage report filters to
  damaged/defective/expired lines and prints evidence counts; party resolved with a second read
  because `wms_return_orders` has no FK to `contacts`.
- **Dispatch seam** `src/features/warehouse/returns/dispatchReturnDocument.ts` — mirrors
  `dispatchGoodsReceipt`: snapshot → `ensureDocumentRecord` → `printDocumentIntent`.
  Returns contains no PDF or printer code.
- **Auto-archive**: posting dispositions fires the return receipt as a `business_event`
  (best-effort; a failed print never invalidates a posted return).
- **Finance handoff RPC** `wms_create_return_finance_doc(p_return_id, p_row_version)` —
  `SECURITY DEFINER`, access-checked, `row_version` guarded, idempotent (returns the existing link),
  refuses unposted lines / cancelled returns / internal + transfer kinds. Creates the
  `sales_returns` or `purchase_returns` header (`pending`, zero money) plus its items from the
  return lines, links it to the RMA and emits `warehouse.return.finance_linked`.
- **UI**: "Paperwork & finance" block in `ReturnWorkspace` — four document buttons plus
  "Raise finance document" (enabled only when every line is dispositioned and posted).
- Verified: `tsgo --noEmit` clean; `wms-no-orphan-modules`, `wms-no-direct-state-writes`,
  `wms-topic-catalog-sync`, `adr-0086-generate-document-client-entrypoint` all pass.

### Pending in Phase 6

1. **6.3 Credit-note linkage.** Warehouse currently links the sales/purchase return only.
   When Finance issues the credit note, `wms_return_orders.credit_note_id` must be populated —
   preferred design is a Finance-side subscriber on `warehouse.return.finance_linked`, or an
   explicit call to `wms_link_return_finance` with `p_credit_note_id`.
2. **6.4 Templates.** The four new `document_kinds` currently render through the default template
   resolution. Kind-specific `document_templates` (RMA authorization, return receipt, inspection
   report, damage report) still need seeding, plus a coverage guard asserting every
   `domain = 'wms'` kind has a template.
3. **6.5 Vendor return note.** Reuse the existing `purchases.return` kind for the physical
   ship-back paper once `return_to_vendor` dispositions produce an outbound shipment.

### Known pre-existing failure (not introduced by Phase 6)

`src/test/architecture/wms-rpc-grants.test.ts` fails for ten LPN functions
(`wms_next_lpn_code`, `wms_lpn_*`, `wms_packaging_consume`) missing `GRANT EXECUTE TO authenticated`.
Owned by the LPN workstream; fix with a grants-only migration before Phase 7 sign-off.

## Phase 7 — Console completion, guards, ADR (next)

- Replace the Sheet with a resizable split-pane workspace (line grid / inspection + evidence /
  event timeline); add the dock–appointment–trailer strip, the LPN rail, and aging + SLA counts on
  the lane board.
- Guards: no direct client writes to any `wms_return_*` table; disposition persisted on the line
  and never only in the outbox; no printer/barcode import outside the label seam; returns document
  dispatch only through `dispatchReturnDocument`.
- Functional tests for `wms_post_return_dispositions`: movement balance, quarantine handling, task
  spawning, close guard, exception raise; plus tests for `wms_create_return_finance_doc`
  (idempotency, unposted rejection, kind routing).
- ADR 0106 documenting the Returns execution model, superseding the header-only model in ADR 0101.

---

## Instructions for the next agent

1. **Verify before building.** Do not take this document on trust. Confirm, against the database
   and the codebase:
   - `document_kinds` contains the four `wms.*` returns kinds and they are active.
   - `wms_create_return_finance_doc` exists, is `SECURITY DEFINER`, has
     `GRANT EXECUTE ... TO authenticated`, is idempotent, and refuses unposted lines.
   - `dispatchReturnDocument` is the only path from Returns into the document engine
     (`rg "ensureDocumentRecord|printDocumentIntent" src/features/warehouse/returns`).
   - `tsgo --noEmit` is clean and the WMS architecture guards still pass.
2. **Then resume chronologically** at Phase 6.3 → 6.4 → 6.5, and only after Phase 6 is coherent
   move to Phase 7. Do not start Phase 7 UI work while credit-note linkage or templates are open.
3. **Rules that hold across phases:** every writer is a `SECURITY DEFINER` RPC with `p_row_version`;
   inventory effects exist only as `stock_movements` inserts inside
   `wms_post_return_dispositions`; migrations stay additive; `/warehouse-app/returns` must remain
   functional at the end of every phase.
