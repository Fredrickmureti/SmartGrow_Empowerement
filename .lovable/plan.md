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

Verdict: Waves 1–7.1.5 are genuine. Wave 7.2 is roughly 3 of 32 call sites done. The architecture direction is sound; I will continue it rather than restart.

## Phase 2 — Plan corrections I am adding

- **New gate 0 (before any further page work):** one migration seeding the missing `document_kinds` rows (`sales.return`, `purchases.return`, `purchases.statement`, `pos.drawer_slip`, `inventory.product_label`) together with their `output_intents` + targets. Grants/RLS unchanged — these are catalog tables.
- **New gate 0b:** confirm `resolve_output_intent` falls back from a named scenario to `default`; if it does not, add the fallback plus a test, before POS.
- **Finish `CreditNotes.tsx`** — the preview path must move to the artifact store, not stay on `usePrintOrPreview`. Same rule applies to every page: a page is "migrated" only when *both* print and preview are off the legacy hook.
- **Reprint audit parity** must be proven before `reprintClient` is folded in: assert a reprint still lands `hardware_command_log.is_reprint = true` end-to-end.
- Idempotency work reduces to a **test only** (DB already correct).
- Kitchen-ticket golden item is **closed**.

## Phase 3 — Execution order (resuming)

Each step lands as one unit: snapshot builder + unit test + contract-suite entry + call-site rewrite (print *and* preview) + allowlist entry removal where the last file in a glob is done.

1. **Gate 0 / 0b** — missing kinds + intents migration; scenario fallback check.
2. **Sales cluster** — `Estimates`, `ProformaInvoices`, `DeliveryNotes`, `SalesOrders` (`sales.order_ack`), `SalesReturns`, `CustomerPayments` (`sales.payment_receipt`), `CustomerStatements` (`sales.statement`); then close out `CreditNotes` preview.
3. **Purchases cluster** — `Bills`, `PurchaseOrders`, `PurchaseReturns`, `VendorStatements` + peek sheet + record page, GRN wizard. Then remove `src/pages/**` and `src/features/purchases/**` from the eslint allowlist.
4. **HR** — `Recruitment`, `ContractsListPage`, `LifecycleTimelinePage`, `LegalRecipients`.
5. **Inventory labels** — `Products.tsx`, `useLabelPrint.ts`, enforcing ADR-0088 (mm-relative geometry) and ADR-0089 (never emit a UUID as barcode); refuse to render when barcode resolution returns null.
6. **POS terminal** — `PostPaymentSurface`, `HistoryWorkspace`, `POSReports`, `usePOSCashDrawer` (requires porting the drawer-slip ESC/POS renderer into the Wave 3 engine), `usePrinterStatus`. Guarded by the thermal + kitchen goldens.
7. **Cross-cutting** — `useDeviceForIntent`, `BusinessSagaMount`, `PrintPreviewDialog`, `reprintClient` (folded into `submitDocumentIntent({ triggeredSource: 'reprint' })` only after the audit-parity proof), `HardwareDevices`.
8. **Wave 7.3** — delete `PrintClient.ts`, `usePrintOrPreview.ts`, `reprintClient.ts`, `BrowserHardwareAdapter.print`, and the now-dead eslint rules.
9. **Waves 7.5 / 8 / 9** — architecture guards, transport-router consolidation, then destructive legacy removal and the `DOCUMENT_PRINT_HARDWARE.md` overview.

## Technical notes

- Snapshot builder contract stays: pure `buildXSnapshot(row)` + `fetchAndBuildXSnapshot(supabase, id)`, returning `{ document_number, document_date, snapshot }`, with a `SUITE` entry in `snapshot-contract.test.ts`.
- Call-site pattern is unchanged: build snapshot → `ensureDocumentRecord({ kindCode, … })` → `submitDocumentIntent({ documentRecordId, scenario })`.
- Cross-wave invariants hold: only `submit-document-intent` writes `print_jobs`; only `dispatch-print-jobs` claims them; hardware only via `hardwareClient`; every new public table ships GRANT + RLS in the same migration.
- Dev dependencies are not currently installed in this sandbox (`vitest` unresolved), so I will install before the first test run and gate each step on a green suite plus a clean `tsgo` typecheck.
