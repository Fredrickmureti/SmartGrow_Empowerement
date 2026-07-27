## Phase 1 — Independent verification (done, not trusted)

I re-checked every claim in `.lovable/plan.md` against the live codebase and database.

**Confirmed true:**
- `src/services/documents/` holds the new seam: `ensureDocumentRecord.ts`, `submitIntent.ts`, `outputIntent.ts`, `DocumentArtifactStore.ts`, plus snapshot builders `posReceipt`, `posKitchenTicket`, `salesInvoice`, `salesCreditNote`.
- Matching unit tests exist for all four builders plus `snapshot-contract.test.ts`.
- `Invoices.tsx` and `KitchenOrderTicket.tsx` are fully off the legacy `PrintClient`.
- `submit_document_intent` in the database **does** have idempotency: it builds a `dedupe_key` of `(document_record_id, target, scenario, version)` and `ON CONFLICT … DO NOTHING` against queued/processing jobs. The plan listed this as unverified — it is in place.
- A kitchen-ticket golden fixture test already exists (`src/test/printing/kitchen-ticket-golden.test.ts`), so that plan item is closed.
- The eslint deprecation ratchet and grandfather allowlist are present as described.

**Claims that were inaccurate or incomplete:**
1. `CreditNotes.tsx` still imports `usePrintOrPreview`. The print path was migrated, but the preview path still rides the legacy hook — the page is not actually finished.
2. The "~30 remaining callers" figure is **32** files, and it includes three purchases files the plan's ordering never named explicitly (`VendorStatementPeekSheet`, `VendorStatementRecordPage`, `GoodsReceiptWizardPage`).
3. **Blocking gap the plan missed:** several document kinds the remaining pages need do not exist in `document_kinds` at all — `sales.return`, `purchases.return`, `purchases.statement`, `pos.drawer_slip`, and a product-label kind (only `price_label` / `shelf_label` / `item_barcode` exist). Migrating those pages will fail at runtime until the kinds are seeded.
4. **Second blocking gap:** `output_intents` contains rows only for `scenario = 'default'`. `submit_document_intent` raises `no_output_intent_matched` when nothing resolves, so any POS `on_close` scenario dispatch will throw unless the resolver falls back to `default`. This must be settled before the POS cluster.
5. Renderer coverage is thinner than implied: `_shared/rendering/renderers/` contains only `escpos`, `html`, `pdf`, `zpl` plus the thermal golden — there is no drawer-slip renderer, confirming fork (2) is still open.
6. `docs/architecture/DOCUMENT_PRINT_HARDWARE.md` (the Wave 9 deliverable) does not exist.

Verdict: Waves 1–7.1.5 are genuine. Wave 7.2 was roughly 3 of 32 call sites done at the time of this audit (now 6 of 32 — see the status snapshot in Phase 3). The architecture direction is sound; I will continue it rather than restart.

## Phase 2 — Plan corrections I am adding

- **New gate 0 (before any further page work):** one migration seeding the missing `document_kinds` rows (`sales.return`, `purchases.return`, `purchases.statement`, `pos.drawer_slip`, `inventory.product_label`) together with their `output_intents` + targets. Grants/RLS unchanged — these are catalog tables.
- **New gate 0b:** confirm `resolve_output_intent` falls back from a named scenario to `default`; if it does not, add the fallback plus a test, before POS.
- **Finish `CreditNotes.tsx`** — the preview path must move to the artifact store, not stay on `usePrintOrPreview`. Same rule applies to every page: a page is "migrated" only when *both* print and preview are off the legacy hook.
- **Reprint audit parity** must be proven before `reprintClient` is folded in: assert a reprint still lands `hardware_command_log.is_reprint = true` end-to-end.
- Idempotency work reduces to a **test only** (DB already correct).
- Kitchen-ticket golden item is **closed**.

## Phase 3 — Execution order (resuming)

Each step lands as one unit: snapshot builder + unit test + contract-suite entry + call-site rewrite (print *and* preview) + allowlist entry removal where the last file in a glob is done.

1. **Gate 0 / 0b — DONE & VERIFIED.** Migration seeded the missing kinds (`sales.return`, `purchases.return`, `purchases.statement`, `pos.drawer_slip`, `inventory.product_label`) with intents/targets, corrected the Wave-4 kind-code typos that were routing thermal/label documents to a PDF download target, and added the scenario→`default` fallback in `resolve_output_intent`. Verified by DB query (`pos.receipt_customer`, `inventory.product_label` now resolve to hardware roles) plus two stale printing guardrails rewritten to the Phase 6 Step C contract.
2. **Sales cluster — IN PROGRESS (active phase).**
   - `Estimates` (`sales.estimate`) — **DONE & VERIFIED.** `snapshots/salesEstimate.ts` (pure + fetcher), 7 unit tests, contract entry, page off `usePrintOrPreview`.
   - `ProformaInvoices` (`sales.proforma`) — **DONE & VERIFIED.** `snapshots/salesProforma.ts`, 7 unit tests, contract entry, page off the legacy hook.
   - `DeliveryNotes` (`sales.delivery_note`) — **DONE & VERIFIED.** `snapshots/salesDeliveryNote.ts` carries the three DN business rules (structural amount suppression + `hide_amounts`, recipient chain contact→POD→staff→legacy with UUID guard, automation-token stripping), 11 unit tests, contract entry, page off the legacy hook.
   - **NEXT:** `SalesOrders` (`sales.order_ack`), then `SalesReturns` (`sales.return`), `CustomerPayments` (`sales.payment_receipt`), `CustomerStatements` (`sales.statement`); finally close out the **`CreditNotes` preview path**, which still imports `usePrintOrPreview` and is the one knowingly half-migrated page in the tree.
3. **Purchases cluster — PENDING** — `Bills`, `PurchaseOrders`, `PurchaseReturns`, `VendorStatements` + peek sheet + record page, GRN wizard. Then remove `src/pages/**` and `src/features/purchases/**` from the eslint allowlist.
4. **HR — PENDING** — `Recruitment`, `ContractsListPage`, `LifecycleTimelinePage`, `LegalRecipients`.
5. **Inventory labels — PENDING** — `Products.tsx`, `useLabelPrint.ts`, enforcing ADR-0088 (mm-relative geometry) and ADR-0089 (never emit a UUID as barcode); refuse to render when barcode resolution returns null.
6. **POS terminal — PENDING** — `PostPaymentSurface`, `HistoryWorkspace`, `POSReports`, `usePOSCashDrawer` (requires porting the drawer-slip ESC/POS renderer into the Wave 3 engine — fork (2) is still open), `usePrinterStatus`. Guarded by the thermal + kitchen goldens.
7. **Cross-cutting — PENDING** — `useDeviceForIntent`, `BusinessSagaMount`, `PrintPreviewDialog`, `reprintClient` (folded into `submitDocumentIntent({ triggeredSource: 'reprint' })` only after the audit-parity proof), `HardwareDevices`.
8. **Wave 7.3 — PENDING** — delete `PrintClient.ts`, `usePrintOrPreview.ts`, `reprintClient.ts`, `BrowserHardwareAdapter.print`, and the now-dead eslint rules.
9. **Waves 7.5 / 8 / 9 — PENDING** — architecture guards, transport-router consolidation, then destructive legacy removal and the `DOCUMENT_PRINT_HARDWARE.md` overview.

### Current status snapshot

- **Active phase:** Wave 7.2, Sales cluster.
- **Call sites migrated:** 6 of 32 (`Invoices`, `KitchenOrderTicket`, `CreditNotes` print-only, `Estimates`, `ProformaInvoices`, `DeliveryNotes`).
- **Verification bar met by each of the above:** clean `tsgo` typecheck for touched files + green `src/test/documents` and `src/test/printing` (currently 33 files / 202 tests passing).
- **Known outstanding debt (not regressions, carried deliberately):** `CreditNotes` preview path; no drawer-slip renderer; `docs/architecture/DOCUMENT_PRINT_HARDWARE.md` not yet written; `PrintPreviewDialog` still present on migrated pages as an operator fallback and is only retired in step 7.

## Instructions for the next agent

1. **Verify before you build.** Do not trust this file. Re-read `salesEstimate.ts`, `salesProforma.ts`, `salesDeliveryNote.ts` and their call sites and confirm: each page imports no `usePrintOrPreview`; each builder is pure + deterministic and has a `SUITE` entry; each `ensureDocumentRecord` call passes a `kindCode` that actually exists in `document_kinds`; the projection still matches the corresponding `generate-document` fetcher field for field. Run the documents + printing suites and a typecheck as your baseline. Note the repo has a pre-existing ~118-failure baseline outside those two suites — do not treat it as caused by this work, and do not widen scope to fix it.
2. **Then resume at step 2's NEXT item — `SalesOrders` (`sales.order_ack`) — not anywhere else.** Land it as one complete unit (builder + tests + contract entry + call-site rewrite covering print *and* preview) before touching the following page.
3. **Keep the invariants:** only `submit-document-intent` writes `print_jobs`; only `dispatch-print-jobs` claims them; hardware access only through `hardwareClient`; every new public table ships GRANT + RLS in the same migration.
4. **Update this file immediately after each completed step**, moving the item to DONE & VERIFIED with the evidence, and re-pointing NEXT.

## Technical notes

- Snapshot builder contract stays: pure `buildXSnapshot(row)` + `fetchAndBuildXSnapshot(supabase, id)`, returning `{ document_number, document_date, snapshot }`, with a `SUITE` entry in `snapshot-contract.test.ts`.
- Call-site pattern is unchanged: build snapshot → `ensureDocumentRecord({ kindCode, … })` → `submitDocumentIntent({ documentRecordId, scenario })`.
- Cross-wave invariants hold: only `submit-document-intent` writes `print_jobs`; only `dispatch-print-jobs` claims them; hardware only via `hardwareClient`; every new public table ships GRANT + RLS in the same migration.
- Dev dependencies are not currently installed in this sandbox (`vitest` unresolved), so I will install before the first test run and gate each step on a green suite plus a clean `tsgo` typecheck.
