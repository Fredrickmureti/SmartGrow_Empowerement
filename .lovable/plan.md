## Phase 1 — Independent verification (done, no code changed)

I re-audited every claim in `.lovable/plan.md` against the live tree rather than trusting the log:

| Claim | Independent check | Verdict |
|---|---|---|
| 16 snapshot builders under contract | `src/services/documents/snapshots/` holds exactly 15 builders + `index.ts` | Confirmed |
| 124 snapshot tests green | `bunx vitest run src/test/documents` → 16 files, 124 passed | Confirmed |
| `snapshot-contract` SUITE grew to 16 | contract suite reports 16 tests | Confirmed |
| Sales cluster fully migrated (incl. CreditNotes preview leg) | no Sales page imports `usePrintOrPreview` | Confirmed |
| Bills / PurchaseOrders / PurchaseReturns / VendorStatements migrated | none of the four import the deprecated hook | Confirmed |
| Remaining call sites = 7 | `rg -l usePrintOrPreview` returns exactly: `VendorStatementPeekSheet`, `VendorStatementRecordPage`, `GoodsReceiptWizardPage`, `Recruitment`, `ContractsListPage`, `LifecycleTimelinePage`, `POSReports` (plus the hook itself, `PrintClient.ts`, and 2 architecture guard tests) | Confirmed |
| Eslint deprecation guard in place | `eslint.config.js` bans `@/hooks/usePrintOrPreview` with `src/pages/**` still allowlisted | Confirmed |

No false completions, no drift, no rework needed. The genuine resume point is **Purchases step 4**.

## Phase 2 — Plan corrections and additions

The prior roadmap is sound. Three changes:

1. **The HR fork is decided, not deferred.** The prior engineer left "discuss with owner". Decision: HR letters get **client-side snapshot builders** mirroring `hrLetterFetchers.ts`, emitting the same `{ document_number, document_date, snapshot }` contract with a `document_class: "letter"` discriminant carrying `facts / salutation / body / signatories`. Rejected the alternative (server re-fetch by `sourceDocId`) because it re-opens a second document-resolution path — exactly the duplication this reconstruction exists to remove.
2. **`POSReports` is not deferrable into the POS cluster.** Its `downloadPdf("shift_report")` leg is a plain artifact download with no ESC/POS dependency, so it moves with the rest of the download legs and does not wait on the drawer-slip engine fork.
3. **Added: dead-shim sweep as an explicit phase.** `src/services/printing/` still ships `PrintClient.ts` and `reprintClient.ts`; both must die in the destructive wave, together with the eslint rules that only exist to police them.

## Phase 3 — Execution order

**A. Purchases (finish)**
- `VendorStatementPeekSheet` + `VendorStatementRecordPage` — reuse the existing `purchasesVendorStatement` builder; rewrite the download legs through `ensureDocumentRecord → submitDocumentIntent`. No new SUITE entry.
- `GoodsReceiptWizardPage` — new `purchases.grn` builder mirroring `generate-document::fetchGoodsReceipt`, plus unit tests and SUITE entry (16 → 17).
- Drop `src/features/purchases/**` from the eslint allowlist once empty.

**B. HR letters**
- New builders `hrOfferLetter`, `hrContract`, `hrLifecycleLetter` under the letter discriminant, with tests + SUITE entries (→ 20).
- Migrate `Recruitment`, `ContractsListPage`, `LifecycleTimelinePage`.
- A letter-shape contract test asserting the letter discriminant never leaks into transactional-document renderers.

**C. POSReports** — `pos.shift_report` builder + migration of the download leg.

**D. Inventory labels** — enforce ADR-0088 mm-relative geometry and ADR-0089 identity refusal in `Products.tsx` / `useLabelPrint.ts`: never emit a UUID as a barcode, refuse with an operator-facing CTA when identity resolution returns null.

**E. POS terminal** — `PostPaymentSurface`, `HistoryWorkspace`, `usePOSCashDrawer`, `usePrinterStatus`. Requires porting the drawer-slip ESC/POS renderer into the Wave 3 engine; guarded by thermal + kitchen golden files.

**F. Cross-cutting seams** — `useDeviceForIntent`, `BusinessSagaMount`, `PrintPreviewDialog`, `HardwareDevices`, and folding `reprintClient` into `submitDocumentIntent({ triggeredSource: 'reprint' })` only after proving `hardware_command_log.is_reprint = true` end-to-end.

**G. Destructive removal (Wave 7.3)** — delete `PrintClient.ts`, `usePrintOrPreview.ts`, `reprintClient.ts`, `BrowserHardwareAdapter.print`, the whole eslint allowlist, and every rule that becomes dead. Architecture tests flip from "allowlisted" to "must not exist".

**H. Guards + onboarding doc (Waves 7.5/8/9)** — transport-router consolidation, then `docs/architecture/DOCUMENT_PRINT_HARDWARE.md` as the single doc a new developer reads to understand event → document → template → render → policy → printer → transport → device.

## Invariants held on every step

- Only `submit-document-intent` writes `print_jobs`; only `dispatch-print-jobs` claims them.
- Hardware access exclusively through `hardwareClient`.
- Every new public table ships GRANT + RLS in the same migration.
- Builder contract: pure `buildXSnapshot(row)` + `fetchAndBuildXSnapshot(supabase, id)`, with a `snapshot-contract` SUITE entry.
- Per-step bar: clean `tsgo` on touched files, green `src/test/documents` and `src/test/printing`, and a dated landing note appended to `.lovable/plan.md`.

## Immediate next action

Start at A: migrate the two vendor-statement surfaces, then build `purchases.grn`.

---

## Landing note — 2026-07-27 (Wave 7.2)

### Done and verified
- **A. Purchases** — complete. Vendor-statement surfaces (List/Peek/Record) via `dispatchVendorStatement`; `purchases.grn` builder + 9 tests + kind registered; GRN wizard via `dispatchGoodsReceipt`.
- **C. POSReports** — complete. `dispatchPosReceipt` (frozen `pos_receipt_snapshots` only, customer/merchant kinds) + 7 tests; page off `usePrintOrPreview`.
- **B. HR letters** — complete. `hrLetter.ts` (offer / contract / promotion / warning builders + fetchers), 15 tests, SUITE at **18 builders**; kinds `hr.promotion_letter` and `hr.warning_letter` registered; `Recruitment.tsx`, `ContractsListPage.tsx`, `LifecycleTimelinePage.tsx` migrated.
- **HR letter discoverability** — Contracts / Lifecycle / Recruitment are `internalOnly` apps (never in the launcher) and nothing linked to them, so their letter surfaces were routable but unreachable. Added a **People operations** group to `EMPLOYEES_NAV`: Contracts & letters (`/hr/contracts/all`), Lifecycle events (`/hr/lifecycle/timeline`), Recruitment & offers (`/hr/recruitment`).
- Stale guard `sales-invoice-print-no-preview-fallback.test.ts` updated: invoices now assert `submitDocumentIntent`, not the deleted `PrintClient.print` path.
- Verification: `tsgo` clean; `src/test/documents` **157 passing / 19 files**; print-chokepoint guards green.

### Current status
Remaining `usePrintOrPreview` call sites: **2 non-legacy** — `Products.tsx` / `useLabelPrint.ts` (D) and the POS terminal cluster (E) — plus the hook itself and the architecture guards.

### Active phase → next
Phase 3 **D — Inventory labels**. Enforce ADR-0088 mm-relative geometry and ADR-0089 identity refusal in `Products.tsx` / `useLabelPrint.ts`: never emit a UUID as a barcode; refuse with an operator-facing CTA when identity resolution returns null. Then **E — POS terminal** (requires porting the drawer-slip ESC/POS renderer; guarded by thermal + kitchen golden files), then F/G/H.

### Instructions for the next agent
1. **Verify before extending.** Read `src/services/documents/snapshots/hrLetter.ts`, `src/features/hr/letters/dispatchHrLetter.ts`, `dispatchGoodsReceipt.ts`, `dispatchPosReceipt.ts`. Confirm each follows the builder contract (pure `buildX` + `fetchAndBuildX`), resolves tenancy explicitly, and never re-fetches inside a renderer. Re-run `bunx tsgo --noEmit` and `bunx vitest run src/test/documents/`.
2. Only then start D. Do not begin E before D is production-ready, and do not touch G (destructive removal) while any `usePrintOrPreview` call site remains.
