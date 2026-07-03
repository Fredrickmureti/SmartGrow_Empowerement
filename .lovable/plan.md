# Continue Enterprise UX Standardization

Picking up exactly where the previous agent stopped. The Purchases ledger has one row left (**RFQs**); after that Purchases closes out and Phase I (Inventory) begins.

## P.3 — RFQs (full 4-surface set)

`src/pages/RFQs.tsx` still hosts two inline `<Dialog>`s (Create + Detail) plus a "Convert to PO" action buried in the Detail dialog. Bring it to the same standard as POs / Bills / Credit Notes / Returns / Expenses.

**New surfaces**

1. `src/features/purchases/rfqs/RFQCreatePage.tsx` — route `/purchases/rfqs/new`, `RecordFormShell` mode=create, sections: *RFQ header* (deadline, notes), *Vendors* (multi-select chips of vendors to solicit), *Line items* (`LineItemsGrid`-style rows: product, qty, uom, notes). Aside = live vendor/line counts summary. Ported verbatim from the existing `handleCreate` in RFQs.tsx.
2. `src/features/purchases/rfqs/RFQEditPage.tsx` — route `/purchases/rfqs/:id/edit`, edit only while `status = 'draft'` (guarded — otherwise redirect to record page with toast). Same layout as create.
3. `src/features/purchases/rfqs/RFQRecordPage.tsx` — route `/purchases/rfqs/:id`, read-only `RecordScaffold` composition: header (RFQ #, status badge, vendor count, deadline), body via a shared `RFQRecordBody` (Details + Line items + Vendor responses table), aside = `DocumentActivityPanel` + status actions (Send / Close / Award).
4. `src/features/purchases/rfqs/RFQPeekSheet.tsx` — `?peek=<id>` on the list, `PeekScaffold` reusing the same `RFQRecordBody` for peek/full parity. Includes "Open full page" link and inline status actions.
5. `src/features/purchases/rfqs/useRFQRecord.ts` — shared hook: load rfq + items + responses, derive totals/stats, expose `convertToPO(vendorId)` calling the existing `awardVendor` + `createPurchaseOrder` pipeline currently inlined in RFQs.tsx.
6. **Award / Convert to PO** stays a `Dialog` (confirmation with vendor picker) — matches the ledger convention for "≤3-field confirm-style picker" actions (same as Credit-Note "Apply to bill").

**List page rewrite (`src/pages/RFQs.tsx`)**

- Delete both inline `<Dialog>` blocks and their state (`showCreateDialog`, `showDetailDialog`, `deadline`, `notes`, `selectedVendorIds`, `lineItems`, `resetForm`, `handleCreate`, `handleConvertToPO`).
- "Create" button → `navigate("/purchases/rfqs/new")`.
- Row click / "View" action → `setPeek(rfq.id)` (drives `?peek=<id>` → `RFQPeekSheet`).
- "Edit" row action (drafts only) → `/purchases/rfqs/:id/edit`.
- Handle `?action=create` deep link from `GlobalCreateMenu` with the same `useEffect` redirect used on POs.

**Route registration (`src/apps/purchases/routes.tsx`)**

Add three lazy routes under the existing `rfqs` branch:
```
rfqs/new              → RFQCreatePage
rfqs/:id              → RFQRecordPage
rfqs/:id/edit         → RFQEditPage
```

**Audit ledger update (`docs/design-system/audit/purchases.md`)**

Flip the RFQs row from **Pending** → **Done** and add the four new rows (Create / Edit / View / Peek) mirroring the Bill / PO entries.

## Purchases close-out

After P.3:

1. Re-run `src/test/architecture/purchases-record-dialog-ban.test.ts` — allowlist should still be empty, no new leaks.
2. `tsgo` typecheck clean.
3. Playwright smoke: list → create → save → record page → peek → edit → convert-to-PO for RFQs; sanity-visit POs / Bills / Credit Notes / Returns / Expenses / Statements list pages to confirm no regressions from earlier phases.
4. Add a short "Purchases app — complete" note at the top of `docs/design-system/audit/purchases.md` with the guard-test filename.

## Phase I — Inventory (starts after Purchases signs off)

Preliminary target list, to be confirmed by re-auditing `src/pages/{Warehouses,Inventory,UomManagement,StockTransfers,StockAdjustments}.tsx`:

- **Stock Transfer** — route + `RecordFormShell` create/edit, `PeekScaffold` peek, `RecordScaffold` view. Line items via `LineItemsGrid`.
- **Stock Adjustment** — same 4-surface set. Reversal stays a `Dialog` (confirm).
- **Warehouse** — `DetailSheet` create/edit + `PeekSheet` (small config record, ≤6 fields).
- **UoM Category / Unit** — `DetailSheet` create/edit (config records).
- **Product / Item Record** — audit; if a full record page already exists, only migrate any remaining Create/Edit dialogs.

Deliverables mirror Purchases:
- `src/features/inventory/<entity>/…` for pages + shared body/hook.
- Routes under `src/apps/inventory/routes.tsx`.
- New audit ledger `docs/design-system/audit/inventory.md`.
- Architecture guard `src/test/architecture/inventory-record-dialog-ban.test.ts` (empty allowlist, mirrors purchases guard).

Phase F (Finance) follows the same template after Inventory signs off — scope determined from a fresh audit at that point.

## Out of scope

- No changes to business logic or DB schema — only interaction/composition.
- Email / send / print dialogs stay `Dialog` (correct pattern).
- Action confirmations (Approve, Cancel, Award, Apply Credit, Reverse) stay `Dialog`.
