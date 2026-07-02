# ADR 0013 — Scanner as ERP-wide input infrastructure

Status: Accepted (2026-05-18)

## Context

The phone-as-scanner work was originally scoped to the POS terminal cart.
The `pos:scan:<register_id>` channel, the `pos_scanner_pairings` table, and
the `scanBus` consumer in `POSTerminal.tsx` all assumed the only target was
a register. Product onboarding, inventory receiving, physical count, and
transfers had no path to use a paired phone — every form had to wire its
own listener (and almost none did).

## Decision

The scanner is repositioned as a first-class ERP input device, not a POS
feature. Three new primitives:

1. **`scanner_sessions` + `scanner_session_pairings`** — a session abstraction
   independent of POS registers. Any authenticated user can open a session
   from any page; the same QR + 60-second pairing flow applies. Topic is
   `scan:session:<id>`.
2. **`scanRouter`** — a focus-aware target stack layered above `scanBus`.
   Components opt in with `useScanTarget({ active, onScan })`; the topmost
   active target receives the next scan, irrespective of source (keyboard
   wedge, paired phone, future serial scale).
3. **`<BarcodeInputField>`** — a reusable scanner-aware input that registers
   itself with the router while focused, shows a status chip, optionally
   runs a duplicate check via `pos_resolve_barcode`, and auto-advances
   focus.

The global keyboard kernel (`useScanCapture`) is mounted once in
`AuthenticatedShell` so it works on every authenticated page, not only the
POS terminal.

## Consequences

- POS terminal behavior is unchanged. `pos:scan:<register_id>` and the cart
  consumer continue to work via the legacy `scanBus.on()` path.
- New screens get scanner support by mounting `<BarcodeInputField>` — zero
  extra wiring.
- Realtime channel access is gated by `can_access_scan_channel` which
  recognises both `pos:scan:*` and `scan:session:*`, enforces active org
  role and branch access.
- Session lifecycle: 8h expiry, single-use 60s pairing tokens, nightly
  purge via `pg_cron`.

## Out of scope

- Per-scan audit log / latency telemetry — deferred to a hardening pass
- AI auto-naming from barcodes — explicitly out of scope per product
  philosophy ("fast onboarding, not magic")

### Native scanner SDKs — Accepted, shipped 2026-05-26 (Wave 8)

Zebra DataWedge and Honeywell DataCollection / SwiftDecoder integration
lands as a thin, vendor-isolated adapter layer under
`src/services/scanner/native/` that ends at the existing `broadcastScan`
seam in `MobileScannerPage`. The cockpit auto-detects the engine from
the Android UA (and the DataWedge JS bridge when present), and the
operator can toggle it from the metrics row. See
`docs/scanner/zebra-datawedge-profile.md` and
`docs/scanner/honeywell-datacollection-profile.md` for the device-side
profile setup, and `docs/audit/2026-05-26-scanner-cockpit-wave-8.md`
for the close-out.

## 2026-05-18 Re-audit completion

- `POSTerminal` and `ReturnDialog` `scanBus.on` consumers now early-return
  when `scanRouter.wasConsumed(event)` is true. The WeakSet flag set inside
  the router previously had no readers; the regression would re-appear the
  moment a `<BarcodeInputField>` mounted inside a POS-aware screen.
- `scanFeedbackBus` carries `source: "field" | "terminal"`. The POS scanner
  channel mirrors only `terminal` ACKs back to the paired phone, so an
  onboarding scan no longer triggers the cashier-side beep.
- `<BarcodeInputField>` accepts `branchId` and forwards it to
  `pos_resolve_barcode` so multi-branch tenants get accurate "already used"
  hints.
- `MobileScannerPage` claim flow is deterministic: register-pairing is
  attempted first, an empty/null result triggers session-pairing, errors
  from either are surfaced once.
- `<BarcodeInputField>` + `<ScannerPairingButton>` are now mounted on
  Products, Physical Count, Goods Receipt, and Stock Transfers — closing
  Phase 4 of the original plan.
- Architecture guard `src/test/architecture/pos-single-scanner.test.ts`
  asserts repo-wide that no file imports the deprecated `useBarcodeScanner`
  hook. Router stack precedence + suppression covered by
  `src/test/pos/scanRouter.test.ts`.

### Still deferred (tracked, not blocking)

- `scan_events` sampled audit table + p95 soak harness.
- Phone-side ring buffer replay on Realtime reconnect.
- Session-pairing RLS SQL test (`scanner_session_rls_test.sql`).
