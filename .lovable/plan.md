# Warehouse Scanning Subsystem — Verification Verdict and Phase 4/5 Completion

Roadmap of record: `.lovable/plan/warehouse-scanning-audit-verdict-and-completion-plan-2026-08-05.md`.

## Phase 1 verification verdict (done this turn)

I re-checked every claim the previous engineer marked complete, against the code and the tests.

**Claims that hold:**

- **One wedge decoder.** `KeyboardScannerDriver` no longer decodes; the guard `single-wedge-decoder.test.ts` exists and passes (3 tests).
- **Entity scan contract.** `wmsEntityScan.ts` (entity vocabulary, wrong-kind refusal, canonical compare) and `EntityScanField.tsx` exist; `wms-entity-scan.test.ts` passes (7 tests).
- **Coverage gaps closed.** `MobileDispatch`, `MobilePack`, `MobileQC`, `MobilePlate`, `LoadingBay`, `YardMarshal`, `GateConsole`, `PackStation`, `LicensePlateView`, `ReceivingSessions` all now go through a sanctioned scan field / intent. `wms-scan-prompt-coverage.test.ts` passes (2 tests).
- Full guard set for this roadmap: 12 tests, all green.

**Verdict:** Phases 0–3 are structurally complete, with one real defect (below). Phase 4 is genuinely not started.

**Build-breaking defect in Phase 3 work — must be fixed first.** `MobilePlate.tsx:91` passes `bin.id` as `_to_location_id`, but `ResolvedLocation` has no `id` — the field is `location_id`. This fails typecheck and, at runtime, would send `undefined` as the destination of every RF plate move. Phase 3 was reported as "verified, tsgo clean", which it was not. Fix is one line: `_to_location_id: bin.location_id`. This becomes Phase 4.0.


**Additional defects found during verification, not in the previous plan:**

1. **Handheld camera affordance missing on the three screens Phase 3 just wired.** `MobileDispatch`, `MobilePack` and `MobileQC` register scan intents but their layout has no `scanLabel`, so on a phone there is no way to invoke the camera — exactly the "no obvious way to scan" complaint the parent brief opens with. `MobileMyWork` likewise.
2. **`ScanStatusChip` is mounted on only two surfaces** (`ReceivingSessions`, `ReceivingSessionWorkspace`) out of ~20 scan surfaces, and never on mobile.
3. **The chip polls `scanRouter` every second** instead of subscribing — a per-surface timer that will multiply as the chip is rolled out. The router needs a change notification.
4. **No scan history exists anywhere** in the repo (confirmed by search), so no undo path for a mis-scan.

These are folded into Phase 4 below.

## Phase 4 — Enterprise operator UX (active)

**4.1 Router change notification.** Add a subscribe/notify seam to `scanRouter` so consumers observe target changes instead of polling. Convert the chip off its 1 s interval. No behaviour change to routing.

**4.2 One operator guidance surface.** Replace `ScanStatusChip`'s machine states with a `ScanGuidance` surface that always answers four questions: what to scan now (intent-derived copy, e.g. "Scan the destination bin" instead of "Listening"), which input is live (camera / gun / paired phone / native engine, read from the existing device-mode + `ScanEvent.source`), what just happened, and what to do next. Desktop renders it inline; mobile renders a compact bar inside `MobileWarehouseLayout` so every RF screen gets it once, not per screen.

**4.3 Explicit outcome taxonomy.** Success / duplicate / wrong-kind / unknown-code become distinct states on the existing tone + haptic + flash channel (`useScanFeedback` already has success/warn/error tones; duplicate and wrong-kind currently collapse into a generic error). Copy comes from the entity vocabulary already built in Phase 2.

**4.4 Scan history strip.** Last five events per surface with source, entity kind and verdict; undo offered only where the underlying action is reversible (carton unload, count line revert) and always routed through the existing `offlineQueue` → `wms_replay_guarded_call` path with a fresh `client_scan_id`. Read-only otherwise.

**4.5 Handheld-first completion.** Give `MobileDispatch`, `MobilePack`, `MobileQC` and `MobileMyWork` their camera affordance with correct continuous/single semantics (Dispatch and Pack are continuous; QC is single). Make single vs continuous a visible per-screen toggle rather than an invisible prop. Pairing stays available and stays optional.

**4.6 Guard.** Extend `wms-scan-prompt-coverage.test.ts`: every RF screen that registers a scan intent must expose a handheld scan affordance, and every scan surface must render the guidance surface.

## Phase 5 — Performance and drift control

- Scan-to-feedback latency measured on the RF screens; remove the redundant listeners and re-renders surfaced while wiring 4.1–4.5.
- Guards for the remaining invariants: no plain input serves as a scan capture inside warehouse code; every scan surface registers an intent; scan mutations stay on the idempotent offline queue.
- ADR recording "one engine, entity-typed intents, handheld-first", superseding the parts of ADR 0013 / 0017 / 0107 it revises.

## Technical notes

- No new bus, no new decoder, no new transport. Everything hangs off `scanBus → scanRouter → useWmsScanIntent → field`.
- Guidance copy is derived from the intent + entity vocabulary already in `wmsScanIntent.ts` and `wmsEntityScan.ts`; no per-screen string literals.
- History and undo are client-side view state over events already flowing on `scanFeedbackBus`; no new tables, no new RPCs unless an undo needs one that does not exist (each will be checked before use).
- Execution order is strict: 4.1 → 4.6, then Phase 5. Each step ends with `tsgo --noEmit` plus the scanning test set green, and this file updated.
