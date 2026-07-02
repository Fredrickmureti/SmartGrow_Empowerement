# Hardware Platform — Wave 10 (PrintService retirement + device resolver wiring)

## Re-audit of Wave 9d.9 claims

Verified independently against source (file paths, line numbers cited):

| Claim | Verdict |
|---|---|
| P4 #19 per-role mutex (`DeviceManager.withRoleLock` + `CommandRouter.roleLock`) | Confirmed real — `electron/hardware/DeviceManager.ts:107`, `CommandRouter.ts:60-72,123`. |
| P4 #22 singleton realtime channel | Confirmed real — `src/services/hardware/assignmentsRealtime.ts` is a ref-counted, per-org channel; `useDeviceAssignments` consumes it via `subscribeAssignments`. |
| P2 #12 Device wizard at `/platform/hardware/devices/new` | Confirmed real — `DeviceWizard.tsx` 424 lines, registered in `routes.tsx:29`. |
| P3 #17 `useResolvedDeviceForDocument` | Existed but **was not wired** into any caller. Closed in this wave. |
| P5 #25 ZPL golden tests | Confirmed real — `src/test/printing/zpl-golden.test.ts`. |

No silent regressions detected.

## Landed this loop

### P0 #6 + P1 #8 — `PrintService` shim retired

- Deleted `src/services/printing/PrintService.ts`.
- New `src/services/printing/types.ts` owns `PrinterStatus`, `PrintFallbackAction`, `PrintFallbackOptions`, `PrintResult`.
- `src/hooks/pos/usePrinterStatus.ts` rewritten to read
  `hardwareClient.devices.getStatuses()` directly. Polling stays opt-in
  (default on in Electron, off in browser). `usePrintWithFallback` routes
  through `printClient` instead of the deprecated HTML pipeline.
- `ReceiptPreviewDialog.tsx` retry now calls `hardwareClient.devices.getStatuses()` (honest probe, no shim).
- `PrintFallbackDialog.tsx` and `PrintPreviewDialog.tsx` updated to the
  new type module / unified registry path.
- New arch guard `src/test/architecture/no-printservice-shim.test.ts`
  fails CI on any re-introduction of the shim or its singleton method
  surface.

### P3 #17 — `useResolvedDeviceForDocument` finished

- Dropped the leftover unused `profiles` destructure.
- New sibling hook `useResolvedPrintPolicyWithDevice` in
  `useDocumentPrintPolicies.ts` returns `{ policy, profile, device }`
  for callers that need device-aware UI (printer label + transport).
  The existing `useResolvedPrintPolicy` shape is unchanged (additive),
  so POSTerminal / POSSettings / TransactionHistoryDialog keep working
  without touching the hot path.

### P3 #16 — `kitchen_ticket` is now a first-class document type

Wave-10 continuation. Closes the audit's last outstanding P3.

- `DocumentType` in `supabase/functions/_shared/templateRenderer.ts`
  gains `'kitchen_ticket'`. The audit's "ad-hoc receipt-shaped kitchen
  payload" path is dead.
- New self-contained ESC/POS builder
  `supabase/functions/_shared/escpos/kitchen.ts` exports
  `buildKitchenTicketEscPos(data, { width, cut, feedLines })`. It is
  intentionally NOT a reuse of the receipt builder — kitchen tickets
  don't carry totals, tax, payments, fiscal blocks, or branding. ASCII-
  only encoding (transliteration on best-effort, '?' on last resort);
  banner uppercase + double-wide + bold; quantity-first item lines;
  modifiers and notes indented two spaces under each item.
- `generate-document/index.ts` short-circuits on
  `documentType === "kitchen_ticket"` after the org-membership + sub
  entitlement checks and BEFORE template/policy resolution. Source row
  is still `pos_transactions` (reused `fetchPOSReceipt`), so tenancy
  gating is unchanged. Caller may pass `station`, `course`, `table`,
  and `paperFormat` ("40mm" | "58mm" | "80mm") in the body — defaults
  are "KITCHEN" banner and 80mm.
- Golden ESC/POS test
  `src/test/printing/kitchen-ticket-golden.test.ts` locks the byte
  stream: ESC @ init, GS V 0 cut, double-wide banner bytes, quantity-
  first formatting, modifier indentation, ASCII-only stream, and 58mm
  banner-clip behavior.

## Files changed

```text
src/services/printing/types.ts                              new
src/services/printing/PrintService.ts                       deleted
src/hooks/pos/usePrinterStatus.ts                           rewrite
src/components/pos/ReceiptPreviewDialog.tsx                 edit  (3 swaps)
src/components/pos/PrintFallbackDialog.tsx                  edit  (type import)
src/components/common/PrintPreviewDialog.tsx                edit  (dead import removed)
src/hooks/hardware/useResolvedDeviceForDocument.ts          edit  (drop unused)
src/hooks/useDocumentPrintPolicies.ts                       edit  (sibling hook)
src/test/architecture/no-printservice-shim.test.ts          new
supabase/functions/_shared/templateRenderer.ts              edit  (DocumentType)
supabase/functions/_shared/escpos/kitchen.ts                new
supabase/functions/generate-document/index.ts               edit  (fetcher + short-circuit)
src/test/printing/kitchen-ticket-golden.test.ts             new
docs/audit/2026-06-09-hardware-wave-10.md                   updated
```

## Closed this loop (continuation pass)

- **Kitchen ticket print path wired** — `PrintClient.printKitchenTicket(transactionId, { station, course, table, paperFormat })` added; `generateDocumentEscPosBytes` forwards station/course/table/paperFormat into the edge function body. `KitchenOrderTicket.tsx` now exposes a Print button that sends the active order to the bound `kitchen_printer` device, using `pos_kitchen_orders.printer_category` as the station identifier (data-driven routing — no new schema).
- **Device-aware hook adopted by all three call sites** — POSTerminal, POSSettings, and TransactionHistoryDialog switched from `useResolvedPrintPolicy` to `useResolvedPrintPolicyWithDevice`. POSSettings now renders a "Will print to: <device label>" badge under the paper-size picker (with an amber "no device bound" hint when the profile resolves to nothing). POSTerminal threads the resolved device id/label into `postPaymentPolicy` for downstream PostPaymentScreen surfaces. TransactionHistoryDialog uses the device label on the Reprint button tooltip.
- **HardwareExecLog batching, saga-key qualification, topology page** — re-verified in source; all three were already implemented (the wave-9d.9 carry-over list was stale). No action required.

## Re-verified, already implemented

| Item | Evidence |
|---|---|
| P4 #20 batched exec log writes | `src/services/hardware/HardwareExecLog.ts` — 2 s / 25-row buffer, cached session id, `onAuthStateChange` invalidation. |
| P4 #21 saga-key tenant qualification | `electron/hardware/SaleSaga.ts:102` — `${terminalId}:${saleId}:${step}` keyFor, bound via `setTerminalId`. |
| P5 #23 hardware topology page | `src/apps/platform/hardware/HardwareTopology.tsx` registered at `/platform/hardware/topology` in `routes.tsx:31`. |

## Files changed (continuation)

```text
src/services/printing/PrintClient.ts                        edit  (printKitchenTicket)
src/services/printing/pdfUtils.ts                           edit  (station/course/table/paper opts)
src/components/pos/restaurant/KitchenOrderTicket.tsx        edit  (Print button)
src/hooks/useDocumentPrintPolicies.ts                       unchanged (hook already shipped wave 10a)
src/pages/pos/POSTerminal.tsx                               edit  (device-aware hook + label)
src/pages/pos/POSSettings.tsx                               edit  (device label badge)
src/components/pos/TransactionHistoryDialog.tsx             edit  (reprint device tooltip)
docs/audit/2026-06-09-hardware-wave-10.md                   updated
```

## Nothing deferred

Every item from the prior plan's deferred list has either been closed in this pass or re-verified as already implemented. The wave-10 hardware/printing audit is complete.

## Pre-existing concerns NOT in scope

- Parked SPA build dependencies (`react-router-dom`, `framer-motion`, `next-themes`, etc.) were installed at the user's request to silence the harness, but the routes themselves are still legacy SPA scaffolding outside the audit envelope.


