# Warehouse Returns (RMA) — Verification Result & Remaining Work

Last updated: 2026-08-02 (independent re-verification by incoming engineer)
**Resume point:** Phase 6.3 → 6.4 → 6.5, then Phase 7.

---

## Phase 1 — Independent verification of the prior engineer's claims

Checked directly against the live database and the codebase, not the notes.

| Claim | Verdict | Evidence |
| --- | --- | --- |
| Phases 0–3 (event catalog, domain model, execution RPCs, hooks) | Confirmed | `wms_capture_return_line`, `wms_inspect_return_line`, `wms_disposition_return_line`, `wms_post_return_dispositions`, `wms_close_return`, `wms_transition_return` all exist, all `SECURITY DEFINER`, all with EXECUTE granted to `authenticated`. |
| Phase 4b — finance linkage moved off raw client update | Confirmed | `wms_link_return_finance` exists and is `SECURITY DEFINER`; `useReturnOrders` calls it with `p_credit_note_id`. |
| Phase 5 — hardware integration | Confirmed at the seam level | Returns label keys and scan intents present; mobile returns route present. |
| Phase 6.1 — document kinds seeded | Confirmed | `document_kinds` contains `wms.rma_authorization`, `wms.return_receipt`, `wms.inspection_report`, `wms.damage_report`, all active. |
| Phase 6.1 — snapshot builder + single dispatch seam | Confirmed | `src/services/documents/snapshots/wmsReturn.ts` exists; `dispatchReturnDocument.ts` is the only Returns caller of `ensureDocumentRecord` / `printDocumentIntent` — no PDF or printer code inside Returns. |
| Phase 6.2 — finance handoff RPC | Confirmed | `wms_create_return_finance_doc` exists, `SECURITY DEFINER`, executable by `authenticated`. |
| Phase 6.4 — templates | **Not done, correctly flagged** | `document_templates` has zero rows for any `wms.*` or return kind; all four kinds fall through to default resolution. |
| Phase 7 — console, guards, ADR | **Not started** | `ReturnWorkspace.tsx` is still a Sheet; no `docs/adr/0106*`; no returns-specific guard test file. |

Conclusion: the prior work is genuine, not a superficial patch, and the status
table in the previous plan was honest. The resume point it named is correct.

---

## Phase 6.3 — Credit-note linkage (resume here)

- Finance-side subscriber on `warehouse.return.finance_linked` that, when the
  credit note is issued against the linked `sales_returns` / `purchase_returns`
  row, calls `wms_link_return_finance` with `p_credit_note_id`.
- Linkage must be idempotent and row-version guarded; a re-issued credit note
  replaces the link rather than duplicating it.
- Warehouse never computes value: it stores the reference only.

## Phase 6.4 — Document templates

- Seed kind-specific `document_templates` for the four `wms.*` returns kinds
  (RMA authorization, return receipt, inspection report, damage report),
  quantity-only layouts with no money columns.
- Coverage guard: every `document_kinds` row with `domain = 'wms'` resolves to
  at least one template.

## Phase 6.5 — Vendor return note

- `return_to_vendor` dispositions produce an outbound shipment and reuse the
  existing `purchases.return` kind for the physical ship-back paper. No new kind.

## Phase 7 — Console completion, guards, ADR 0106

**Console.** Replace the Sheet with a resizable split-pane operations console:
line grid / inspection + evidence / event timeline. Add the
dock–appointment–trailer strip (the columns already exist on
`wms_return_orders` and are unused in the UI), the LPN rail, and aging + SLA
counts on the lane board. Lane board answers at a glance: arrived, awaiting
inspection, awaiting scan, blocked, quarantined, awaiting approval, awaiting
finance, awaiting print.

**Guards (new test file).**
- No direct client writes to any `wms_return_*` table.
- Disposition persisted on the line, never only in the outbox.
- No printer or barcode import outside the label seam.
- Returns document dispatch only through `dispatchReturnDocument`.

**Functional tests** for `wms_post_return_dispositions` (movement balance,
quarantine handling, task spawning, close guard, exception raise) and for
`wms_create_return_finance_doc` (idempotency, unposted rejection, kind routing).

**ADR 0106** documenting the Returns execution model, superseding the
header-only model in ADR 0101.

## Phase 7b — Inherited defect to clear before sign-off

`src/test/architecture/wms-rpc-grants.test.ts` fails for ten LPN functions
missing `GRANT EXECUTE TO authenticated`. Pre-existing, owned by the LPN
workstream, but it blocks a clean guard run — fix with a grants-only migration.

---

## Invariants that hold across every phase

- Every writer is a `SECURITY DEFINER` RPC taking `p_row_version`; direct state
  UPDATEs from the client stay forbidden and are enforced by tests.
- Inventory remains the stock authority: the only inventory effect path is
  `stock_movements` inserts inside `wms_post_return_dispositions`.
- Warehouse links finance documents; it never values them.
- Migrations stay additive; `/warehouse-app/returns` remains functional at the
  end of every phase.

---

## Wave closed — 2026-08-03

- Phase 6.3 credit-note backlink trigger, 6.4 template seeding, 6.5 vendor
  return note: done.
- Phase 7.1 console: split-pane workspace, dock–appointment–trailer strip
  (`ReturnLogisticsStrip`), LPN rail (`ReturnLpnRail`), lane-board aging +
  per-lane SLA breach counts (`RETURN_LANE_SLA_HOURS`, `laneStats`).
- Phase 7.2 guards + ADR 0106: done.
- Phase 7.3 functional contracts: `src/test/architecture/wms-returns-execution.test.ts`
  covers posting (movement balance, quarantine hold, task spawning, blocked
  exception path), finance handoff (idempotency, unposted rejection, kind
  routing) and the close guard.
- Phase 7b LPN/packaging grants: cleared by migration; guard suite green.
