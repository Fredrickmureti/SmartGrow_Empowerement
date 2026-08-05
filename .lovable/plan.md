# Warehouse Scanning Subsystem — Authoritative Project Status

Roadmap of record: `.lovable/plan/warehouse-scanning-audit-verdict-and-completion-plan-2026-08-05.md`.
Execution is chronological: Phase 0 → 5. Do not start a later phase before the current one is coherent.

## Current position

- **Completed and verified:** Phases 0, 1, 2, 3.
- **Active phase:** Phase 4 — enterprise operator UX (not started).
- **Next task:** Phase 4.1, the shared operator guidance surface (see "Next milestone").

## Phase 0 — Verification pass — DONE
Confirmed `KeyboardScannerDriver` was live, that product and location were the only server-side resolvers, and that the existing guard tests still hold. No behaviour changed.

## Phase 1 — One wedge decoder — DONE, verified
- `KeyboardScannerDriver` no longer decodes: it subscribes to `scanBus` and re-emits to `hardwareEventBus` for diagnostics only.
- `HidScannerDriver` publishes WebHID decodes to `scanBus` with `source: 'hardware'`.
- `ScanEvent` / `ScanProgress` carry `hardware` as a first-class source; `POSTerminal` types its handler off `ScanEvent["source"]`.
- Guard: `src/test/architecture/single-wedge-decoder.test.ts` (3 tests, green) — `useScanCapture` is the only sanctioned keyboard-wedge decoder.

## Phase 2 — One scan contract per entity — DONE, verified
- `src/features/warehouse/scanning/wmsEntityScan.ts` — entity vocabulary (`lpn`, `carton`, `manifest`, `trailer`, `gate_pass`, `yard_slot`, `asn`), `gateEntityToken()` wrong-kind refusal, `normalizeEntityCode()` / `entityCodeEquals()` canonical compare.
- `src/features/warehouse/scanning/EntityScanField.tsx` — the third sanctioned scan field alongside `BinScanField` (positions) and `ProductScanField` (products). Admission is gated centrally; resolution stays with the screen that owns the domain.
- Tests: `src/test/warehouse/wms-entity-scan.test.ts` (7 tests, green).

## Phase 3 — Coverage gaps closed — DONE, verified
Mobile RF:
- `MobileDispatch` — carton LPN loading via `EntityScanField`, duplicate-carton refusal.
- `MobilePack` — carton seal by scanned label.
- `MobileQC` — verdict buttons blocked until the item is scanned (`ProductScanField`).
- `MobilePlate` detail — destination bin now `BinScanField` (resolves through `resolve_location_identity`); the ad-hoc bin-code compare and its local bin query are gone.

Desktop execution mirrors:
- `LoadingBay` — raw carton input replaced by `EntityScanField` (`load.lpn` / `carton`), refuses already-loaded cartons, loads via the existing RPC mutation.
- `YardMarshal` — destination prompt is now `EntityScanField` (`yard.slot`), validated against the yard's slot and dock registers; the duplicate manual intent registration was removed.
- `GateConsole` — new gatehouse scan path: a gate pass or trailer placard matches an expected appointment and opens `GateCheckInDialog` pre-filled (`initialAppointmentId`); a trailer already on site opens its visit instead.
- `PackStation`, `LicensePlateView`, `ReceivingSessions` were already on the intent engine (verified, unchanged).

By design and recorded so a later pass does not "fix" it: planning, master-data and BI screens (`WavePlanner`, `Slotting`, `DockSchedule`, catalogues, dashboards) stay scanner-free. `QCInspectionDetail`'s inputs are inspection results, not scan prompts.

Guards: `src/test/architecture/wms-scan-prompt-coverage.test.ts` (2 tests, green) — no RF screen renders a bare scan input, and every desktop execution mirror owns a scan path.

Verification run: `tsgo --noEmit` clean; eslint on all touched files clean (2 pre-existing dependency warnings, untouched); the scanning test set (11 + 2 tests) green. The ~137 unrelated failing suites in the repo predate this work and are outside this roadmap.

## Phase 4 — Enterprise operator UX — NOT STARTED (active phase)
1. A shared scan guidance surface replacing machine states: "what to scan now", which input is live (camera / gun / paired phone / native engine), what just happened. `ScanStatusChip`'s "Listening" becomes prompt-specific copy; it must be mounted on mobile as well as desktop.
2. Explicit success / reject / duplicate / wrong-kind states on the existing tone + haptic + flash channel.
3. A scan history strip (last five events, undo where the underlying action is reversible).
4. Single vs continuous scan as a visible per-screen mode, not an invisible prop.
5. Handheld-first: every scan surface fully usable on the device in the operator's hand; pairing stays optional.

## Phase 5 — Performance and drift control — NOT STARTED
Scan-to-feedback latency on RF screens, removal of redundant listeners/re-renders found while wiring, and guards for the remaining invariants (every scan surface registers an intent; scan mutations stay on the idempotent offline queue). Also outstanding from the roadmap: the ADR recording "one engine, entity-typed intents, handheld-first".

## Instructions for the next agent

1. **Verify before building.** Confirm Phases 1–3 hold to enterprise standard before writing new code:
   - `bunx tsgo --noEmit`, then `bunx vitest run src/test/architecture/single-wedge-decoder.test.ts src/test/architecture/wms-scan-prompt-coverage.test.ts src/test/warehouse/wms-entity-scan.test.ts`.
   - Read `LoadingBay`, `YardMarshal`, `GateConsole`, `MobilePlate`, `MobileDispatch`, `MobilePack`, `MobileQC` and confirm every scan prompt is a sanctioned field, every mutation still goes through its RPC/offline-queue path, and no screen re-registers an intent a field already owns.
   - Confirm no second decoder has reappeared outside `useScanCapture`.
2. **Then resume at Phase 4.1** — the shared operator guidance surface — and finish Phase 4 in full before touching Phase 5. Do not start unrelated work, and do not leave a phase partially wired.
3. Update this file at each implemented step so it stays the authoritative status.
