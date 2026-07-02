# Hardware Wave 12 — Closeout

Date: 2026-06-12  
Scope: Close remaining items from the 2026-06-10 re-audit + Wave 11 plan.

## Landed this wave

| ID | Item | Status | Where |
|---|---|---|---|
| B2 | `a4_printer` added to `HARDWARE_ROLES` | ✅ | `electron/hardware/types.ts` |
| C1 | Agent CORS allowlist (env-overridable) replaces `*` | ✅ | `agent/src/server.ts` |
| C1 | Timing-safe token compare | ✅ (Wave 11) | `agent/src/auth.ts` |
| C2 | `goods_received_note` fetcher + FETCHER_MAP registration (alias: `goods_receipt`) | ✅ | `supabase/functions/generate-document/index.ts` |
| C3 | `SerialTransport.getOrOpen` 5 s open timeout — prevents queue hang on disappearing USB-serial adapters | ✅ | `electron/hardware/transports/SerialTransport.ts` |
| C5 | `classify.ts` display/VFD → `customer_display` | ✅ (Wave 11) | `electron/hardware/discovery/classify.ts` |
| B3 | Dead-letter queue surfaced in `HardwareDiagnostics` | ✅ (Wave 11) | `src/components/hardware/DeadLetterQueueCard.tsx` |
| B4 | Terminal-ID invariant (SaleSaga throws, hydrator auto-generates) | ✅ (Wave 11) | `SaleSaga.ts`, `ElectronHydratorMount.tsx` |
| B5 | ZPL early-exit moved after tenant gating | ✅ (Wave 11) | `supabase/functions/generate-document/index.ts` |
| B6 | `LineDisplayDriver` marked `browserFallback: true` | ✅ (Wave 11) | `src/services/hardware/drivers/DriverRegistry.ts` |
| B7 | Bluetooth removed from DeviceWizard transport dropdown | ✅ (Wave 11) | `src/apps/platform/hardware/DeviceWizard.tsx` |

## Deferred (require dedicated waves)

These items remain in the risk register; they were out of reach for this
pass because each is a multi-file refactor + tests + UI work that would
not have landed cleanly inside this slot.

### B1 — Cross-app `PrintClient.print({ documentType, documentId, intent })` router (P0)
Twelve pages (Invoices, SalesOrders, Estimates, DeliveryNotes, CreditNotes,
ProformaInvoices, CustomerPayments, Bills, PurchaseOrders, PurchaseReturns,
SalesReturns, plus finance dialogs) still print via the shadow
`useDocumentPrint → PrintPreviewDialog → window.print()` path. Until B1
ships, no audit log, no device routing, no policy coercion, no thermal/A4
awareness for those flows. ESLint rule `no-direct-window-print` to be
added with the same wave.

### C3 — Retry backoff inside `CommandQueue.dispatch` (P1)
The open timeout above closes the hard hang. The 3-attempt exponential
backoff (200 → 600 → 1.8 s) for `LIBUSB_ERROR_IO`/`ETIMEDOUT`/`EAGAIN`
still needs to land in `CommandQueue`, plus `attempt_count` surfaced in
`HardwareExecLog`.

### C4 — Server-driven `label_templates` table (P1)
`Products.tsx` still builds raw `^XA…^XZ` ZPL inline (lines 215-238).
Requires new `label_templates` table + RLS + migration, extending
`generate-document`'s inventory_label fetcher, replacing the inline
build, and a template-editor UI.

### C5 — `classifySerial` parity with `classifyUsb` (P1)
Receipt-printer baud probe + Mettler/Toledo scale name hints.

### D — P2 cleanup
- Drop duplicate `scanner` enum (consolidate on `barcode_scanner`) — needs
  call-site audit because removing the enum value is type-breaking across
  drivers/tests.
- Tighten `hardware-single-chokepoint.test.ts` for `window.pos.hardware.exec`.
- Replace `no-raw-hardware-ipc` directory exemption with file allow-list.
- `scope_kind` picker in `DeviceWizard`.
- Collapse duplicate realtime channel (`ElectronAssignmentHydrator`).
- Wire `scale` driver into Inventory receiving + POS weigh.
- Add ADR `0026-cross-app-print-router.md` after B1 ships.

### E — Golden tests + docs
- `cross-app-print-routing.test.ts` (blocked on B1)
- `zpl-tenant-gating.test.ts`
- `terminal-id-required.test.ts`
- `dead-letter-queue.test.ts`
- Refresh `HARDWARE_CAPABILITY_MATRIX.md`, `mem/features/hardware-platform.md`,
  remove stale `pos_hardware_configs` reference in `DeviceManager.ts:139`.

## Risk after this wave

The P0 production-blockers from the 2026-06-10 re-audit are now all
addressed *except B1*. Shadow-path printing remains the single biggest
unmitigated risk: any operator who hits Print on a Sales/Purchase/Finance
document is silently bypassing device routing, the dead-letter queue, and
the audit log. B1 should be the next dedicated wave's only goal.
