# Sales scanning on phones — device-mode correctness pass

## Verdict (from reading the current code)

1. **The Rapid/Browse chip is unconditionally mounted.** `SalesLayout` renders
   `<SalesScanChip>` and `<SalesScanReviewDrawer>` in a `fixed bottom-3 right-3`
   stack for every viewport. `SalesScanChip` only checks `available` (is the
   Sales scan provider mounted) — it never consults `scannerDeviceMode`. On a
   phone that overlay sits exactly where the Sales list's primary action lives,
   so it collides with "Create invoice".

2. **The mode itself is a workstation concept.** Rapid/Browse decides what
   happens when an *unattended* stream (USB wedge or paired companion phone)
   fires while no invoice dialog is open. On a handheld the operator opens the
   camera deliberately — there is no unattended stream, so the toggle is
   meaningless there, not just visually inconvenient.

3. **Camera scanning inside invoice creation is technically present but not
   discoverable.** `InvoiceCreatePage` / `InvoiceEditPage` render
   `<InvoiceLineScanner>` on all breakpoints, and its `<ScannerPairingButton>`
   is already handheld-aware (primary "Scan" via `useLocalScan`, pairing
   demoted). But the surrounding block is written for a desk: the header copy
   is "press F2 to refocus", the camera action is a small `size="sm"` button
   competing with the hint text, and there is no continuous-scan affordance —
   so on a phone it reads as "pair a phone", which is exactly the confusion
   reported. The plumbing (LocalScanOverlay mounted once in
   `AuthenticatedShell`, decode → `scanBus` → `scanRouter` → Sales controller)
   is correct and needs no change.

Nothing about the pipeline is architecturally wrong. This is a device-mode
presentation gap, per ADR 0107 / the scanner-device-modes memory.

## Changes

### A. Chip becomes workstation-only
- `SalesScanChip` returns `null` when `useLocalScan().handheld` is true
  (in addition to the existing `available` check), so the mode toggle only
  appears where mode has meaning.
- `SalesLayout`'s floating stack is hidden on handheld too, so no empty
  fixed container overlaps the mobile primary action; the review drawer keeps
  rendering on workstations exactly as today.

### B. Invoice line scanner gets a real phone surface
In `InvoiceLineScanner`:
- Read `useLocalScan()`.
- **Handheld layout:** a full-width primary "Scan with camera" button
  (`<ScanCameraButton withText continuous>`), label "Scan product", placed
  above the manual field; the manual `<BarcodeInputField>` stays as the
  type-a-code fallback with a phone-appropriate placeholder; the F2 hint copy
  is replaced with "Tap scan, or type a code" and the pairing icon is demoted
  to the corner (already the `ScannerPairingButton` handheld behaviour).
- **Workstation layout:** unchanged — same hint text, same pairing button,
  same field.
- Focus/refocus logic, the `useSalesScanController` registration, `onResolved`,
  and the flash feedback are untouched, so a camera decode lands on the same
  path as a wedge scan.

### C. No new plumbing
No new `useScanTarget`, no second camera engine, no new RPC — the camera button
routes through the existing `openLocalScan` seam only.

## Verification
- `bunx tsgo --noEmit`.
- Existing guards must stay green:
  `src/test/architecture/scanner-single-camera-engine.test.ts`,
  `src/test/architecture/invoice-scanner-no-domquery.test.ts`,
  `src/test/sales/sales-scan-context.test.tsx`.
- Playwright pass at 390x844 with the device-mode override forced to
  `handheld`: Sales list shows no floating chip over the Create button; the
  invoice create page shows the "Scan with camera" primary action.
- Desktop pass at 1280 wide: chip and pairing flow unchanged.

## Out of scope
- Changing scan routing, dedupe, or the Rapid/Browse semantics themselves.
- Warehouse `/wm` surfaces (already handheld-correct via `scanLabel`).
