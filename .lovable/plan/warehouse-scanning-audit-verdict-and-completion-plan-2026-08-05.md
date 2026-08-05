# Warehouse Scanning: Audit Verdict and Completion Plan

## What the audit found

The scanning kernel is **already one engine**, and it is good. There is a single keyboard-wedge decoder, a single camera decode engine, a single native-vendor seam (Zebra / Honeywell / SwiftDecoder), one focus-aware router with intent conflict detection, GS1 pre-parsing, cross-source dedupe, identity gating, offline replay with server-side idempotency, and 14 architecture guard tests holding it in place. The reference model used by Odoo, SAP EWM and Manhattan — modules declare what they expect to be scanned, one engine decides the input source and delivers a normalised event — is the model this codebase already implements (`useWmsScanIntent` → `scanRouter` → `scanBus`).

So this is **not** a rebuild. The defects are coverage, consistency and operator feedback, plus one genuine duplicate decoder.

### Confirmed defects

1. **Scan-capable screens that never registered an intent.** `/wm/dispatch` describes itself as "scan carton LPNs onto a loading manifest" but renders a plain text input: no camera button, no intent, no identity gate, no idempotent scan path. `/wm/pack` and `/wm/qc` have the same shape. `MobilePlate`'s detail/move view drops the scan button its lookup view has.
2. **Desktop execution screens with no scan path at all**, though they mirror physical work: `PackStation`, `LoadingBay`, `GateConsole`, `QCInspectionDetail`, `LicensePlateView`, `ReceivingSessions`. A wedge gun can "type" into their inputs by accident, which is worse than no support: no validation, no dedupe, no feedback.
3. **`YardMarshal` is a scan-shaped hack** — a camera button next to a raw text input, bypassing the intent registry and the identity gate.
4. **A second wedge decoder exists.** `src/services/hardware/drivers/KeyboardScannerDriver.ts` re-implements capture-phase keydown burst decoding and emits to `hardwareEventBus` instead of `scanBus`. No guard test covers it. This is the architectural drift.
5. **Operator feedback is thin and asymmetric.** `ScanStatusChip` shows "Listening" / "Held by …" / "No scanner target" — machine states, not instructions — and it is mounted only on desktop. The mobile RF app has tone, haptics and a colour flash but never states what is expected next, which input device is live, or what just happened.
6. **No scan history** anywhere, so an operator who mis-scans cannot see or undo the last few events.
7. **Non-product entities are second-class.** Product and location have real resolvers and gates. LPN, carton, trailer, gate pass, dock and manifest are declared in the intent union but arrive as raw strings with no resolution, no wrong-kind detection and no operator copy.

## Plan

### Phase 0 — Verification pass (no behaviour change)
Confirm before touching anything: whether `KeyboardScannerDriver` is live or dead code; which non-product resolvers actually exist server-side (LPN, trailer, dock, gate pass); whether the `scanner-local-scan-entry` guard cited in `localScanService.ts` still exists. Findings adjust Phases 2 and 3 only.

### Phase 1 — Remove the second decoder
Fold `KeyboardScannerDriver` onto the kernel: it stops decoding and forwards raw hardware input to `scanBus` with a `hardware` source, so router precedence, dedupe and telemetry apply uniformly. Add an architecture guard that fails the build on any new capture-phase keydown barcode decoder outside `useScanCapture`.

### Phase 2 — One scan contract for every entity
Extend the identity layer so every scannable entity gets what product and location already have: resolve → decision → operator copy → wrong-kind rejection. Entities: LPN/pallet, carton, manifest/shipment, ASN, trailer, dock, gate pass, lot and serial (the last two through the existing GS1 AI parsing). Each gets a resolver hook and a typed scan field, all built on `useWmsScanIntent`. No new transports, no new buses.

### Phase 3 — Close the coverage gaps
Wire the identified screens to the Phase 2 contract:
- Mobile: `MobileDispatch` (carton LPN onto manifest, continuous mode), `MobilePack` (item + carton), `MobileQC` (LPN / serial), `MobilePlate` detail (destination bin for moves).
- Desktop execution mirrors: `PackStation`, `LoadingBay`, `GateConsole`, `QCInspectionDetail`, `LicensePlateView`, `ReceivingSessions`.
- `YardMarshal`: replace the camera-button-plus-raw-input with proper trailer and slot scan fields.

Planning, master-data and BI screens stay scanner-free by design. That is correct, and the plan records it so a later pass does not "fix" it.

### Phase 4 — Enterprise operator UX
Replace machine states with operator guidance, consistently on mobile and desktop:
- A shared scan status surface that always answers: what to scan now, which input is live (camera / gun / paired phone / native engine), did it work, what next. "Listening" becomes, for example, "Scan the destination bin".
- Explicit success / reject / duplicate / wrong-kind states using the existing tone, haptic and flash, plus a short **scan history strip** (last five, with undo where the underlying action is reversible).
- Single vs continuous scan becomes a visible per-screen mode rather than an invisible prop.
- Handheld-first: every scan surface must be fully usable on the device in the operator's hand. Pairing stays available but is never the primary or only route.

### Phase 5 — Performance and drift control
Verify scan-to-feedback latency on the RF screens, remove redundant listeners and re-renders found while wiring, and add guards for the new invariants: no plain input may serve as a scan capture inside warehouse code; every scan surface must register an intent; scan mutations stay on the idempotent offline queue.

## Technical notes

- The canonical path stays `scanBus → scanRouter → useWmsScanIntent → field`. No new bus, no new decoder, no per-module scan handling.
- New resolvers follow the existing decision-envelope pattern (ADR 0114) and the `identityOutcome` copy taxonomy; no capture surface queries identifier tables directly.
- All new WMS mutations go through `offlineQueue` → `wms_replay_guarded_call` with a `client_scan_id`, preserving replay idempotency.
- Any new server-side resolution is a migration adding security-definer RPCs with grants and RLS, mirroring `resolve_product_identity` and `resolve_location_identity`.
- A new ADR records the "one engine, entity-typed intents, handheld-first" decision and supersedes the parts of ADR 0013 / 0017 it revises.

## Scope note

This is large. Phases 0–1 are the architecture fix, 2–3 the functional completion, 4–5 the enterprise finish. I will execute them in order and report at each phase boundary rather than delivering everything in one drop.