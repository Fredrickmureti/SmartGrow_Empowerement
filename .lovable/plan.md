# Document → Print → Hardware Reconstruction — Verified Status & Continuation Plan

## Phase 1 — Independent verification (complete, no code changed)

I checked every claim in `.lovable/plan.md` against the live tree rather than trusting the log.

### Claims that hold up

| Claim | Evidence | Verdict |
|---|---|---|
| Purchases cluster (A) complete | `dispatchVendorStatement.ts`, `dispatchGoodsReceipt.ts` exist; `VendorStatementPeekSheet/RecordPage`, `GoodsReceiptWizardPage` consume them | Confirmed |
| HR letters (B) complete | `snapshots/hrLetter.ts` + `features/hr/letters/dispatchHrLetter.ts`; `Recruitment`, `ContractsListPage`, `LifecycleTimelinePage` migrated | Confirmed |
| POSReports (C) complete | `features/pos/receipts/dispatchPosReceipt.ts`; page migrated | Confirmed |
| 18 snapshot builders under contract | 18 builder files + `index.ts`; `snapshot-contract.test.ts` reports 18 tests | Confirmed |
| Test suite green | `src/test/documents` → 19 files, **157 passed** | Confirmed |
| `usePrintOrPreview` nearly dead | only the hook itself, `PrintClient.ts`, 2 guard tests, and 2 doc-comment mentions reference it | Confirmed |

### Claims that are wrong

**The progress log mis-states the remaining work.** It says: *"Remaining `usePrintOrPreview` call sites: 2 non-legacy — `Products.tsx`/`useLabelPrint.ts` (D) and the POS terminal cluster (E)."*

Neither `Products.tsx` nor `useLabelPrint.ts` imports `usePrintOrPreview`. They import **`printClient`** directly. The previous engineer tracked the wrong shim: `usePrintOrPreview` is essentially dead, but **`PrintClient.ts` is very much alive with 18 non-test importers in application code**:

```text
Labels / documents   Products.tsx, useLabelPrint.ts, LegalRecipients.tsx,
                     CustomerStatements.tsx, VendorStatements.tsx
POS terminal         PostPaymentSurface.tsx, HistoryWorkspace.tsx,
                     usePOSCashDrawer.ts, usePrinterStatus.ts,
                     lib/pos/receipt/renderers/index.ts
Cross-cutting        useDeviceForIntent.ts, BusinessSagaMount.tsx,
                     PrintPreviewDialog.tsx, ReprintButton.tsx,
                     DocumentHistoryPanel.tsx, DocumentArtifactStore.ts,
                     HardwareDevices.tsx, BrowserHardwareAdapter.ts,
                     services/printing/reprintClient.ts
```

So phases **D and E are not "nearly done" — they have not started**, and their real scope is larger than logged. The ratchet also never tightened: `eslint.config.js` still blanket-allowlists `src/pages/**`, `src/features/purchases/**`, `src/apps/pos/**`. And the onboarding doc from phase H (`docs/architecture/DOCUMENT_PRINT_HARDWARE.md`) does not exist.

**Genuine resume point: start of D, with corrected scope.**

## Phase 2 — Plan corrections and additions

The direction is right; five things must be added, because inspecting the real `printClient` call sites exposed responsibility leaks the original roadmap never named.

1. **The migration target is `PrintClient`, not `usePrintOrPreview`.** Rewrite phases D–G around retiring `printClient`. `usePrintOrPreview` deletes almost for free.
2. **Export is not a document.** `CustomerStatements.tsx` and `VendorStatements.tsx` call `printClient.downloadExport(...)` for CSV/XLSX data extracts. A data extract is not a rendered document and must not travel the print pipeline. It gets its own owner (`src/services/exports/`), not a fold-in to `submitDocumentIntent`.
3. **Device state is hardware's job, not the print client's.** `usePrinterStatus`, `useDeviceForIntent`, and `HardwareDevices` read device health through `printClient`. Per the hardware README the sole chokepoint is `hardwareClient`. These move to `hardwareClient` and never gain a document dependency.
4. **A cash drawer is not a document.** `usePOSCashDrawer` routes a pure hardware op through the print client. It goes direct to `hardwareClient.exec({ role: 'cash_drawer' })`.
5. **Reprint is a disposition, not a client.** `reprintClient.ts` becomes `submitDocumentIntent({ triggeredSource: 'reprint' })`, proven by asserting the reprint flag lands in the command log before the file is deleted.

## Phase 3 — Execution order

**D. Labels — DONE (2026-07-27).**
`useLabelPrint` now calls `printLabelByTemplate` directly; `Products.tsx` lost ~100 lines of duplicated refusal/identity logic and consumes the hook. ADR-0089 identity refusal and the "no label printer bound" behaviour are preserved and guarded by `products-label-print.test.ts`. Allowlist entry removed.

**E. Exports — DONE (2026-07-27).**
New owner `src/services/exports/` (`documentExport.ts` + barrel). `exportDocument` / `downloadExport` deleted from `PrintClient`; both statement pages migrated. Rationale recorded in the module header: an extract has no template, geometry, policy, or device, so it is not a document — the only shared concern is the `document_artifacts` archive row, which is archival, not printing. Guarded by `export-not-document.test.ts` (bidirectional: exports must not import printing/hardware, and the print client must not regrow export methods).

**F. Hardware seams** — `usePrinterStatus`, `useDeviceForIntent`, `usePOSCashDrawer`, `HardwareDevices`, `BrowserHardwareAdapter` onto `hardwareClient`.

_Progress (2026-07-27):_ `PrintIntent` moved out of `PrintClient` into the neutral vocabulary module `services/printing/types.ts`, so intent-based routing (`useDeviceForIntent`, `usePrinterStatus`, `usePrintOrPreview`, the parity guard) no longer depends on the doomed dispatch shim. `PrintClient` re-exports it for existing callers. `intent-to-role-parity.test.ts` now reads the union from `types.ts`.

_Scope correction:_ `usePOSCashDrawer` was listed here on the assumption it issues a raw drawer-kick op. It does not — it dispatches a **`drawer_slip` document** via `printClient.print(...)`. That is a document-dispatch call, so it belongs with **G** (it needs the drawer-slip ESC/POS renderer ported into the shared engine before it can move). Same for `usePrintWithFallback` inside `usePrinterStatus`, whose two `printClient.print` calls are document dispatch, not hardware status. What genuinely remains in F is the status/device-resolution half.


**G. POS terminal** — `PostPaymentSurface`, `HistoryWorkspace`, `lib/pos/receipt/renderers`. Requires porting the drawer-slip ESC/POS renderer into the shared engine; guarded by thermal + kitchen golden files.

**H. Document surfaces** — `PrintPreviewDialog`, `DocumentHistoryPanel`, `DocumentArtifactStore`, `BusinessSagaMount`, `ReprintButton`/`reprintClient`, `LegalRecipients`.

**I. Destructive removal** — delete `PrintClient.ts`, `usePrintOrPreview.ts`, `reprintClient.ts`, the entire eslint allowlist block, and every rule that becomes dead. Architecture guards flip from "allowlisted" to "must not exist".

**J. Onboarding doc** — `docs/architecture/DOCUMENT_PRINT_HARDWARE.md`: the single file a new developer reads to follow event → document → template → render → policy → printer → transport → device.

## Invariants held on every step

- Only `submit-document-intent` writes `print_jobs`; only `dispatch-print-jobs` claims them.
- Hardware access exclusively through `hardwareClient`; document dispatch exclusively through `submitDocumentIntent`.
- Builder contract: pure `buildXSnapshot(row)` + `fetchAndBuildXSnapshot(supabase, id)` with a `snapshot-contract` SUITE entry.
- Every new public table ships GRANT + RLS in the same migration.
- Per-step bar: clean `tsgo` on touched files, green `src/test/documents` and `src/test/printing`, allowlist entry removed, dated landing note appended.

## Immediate next action

Finish **F**'s remaining half (device resolution + status onto `hardwareClient`), then start **G** by porting the drawer-slip ESC/POS renderer into the shared engine — that port is the blocker for both `usePOSCashDrawer` and `usePrintWithFallback`.
