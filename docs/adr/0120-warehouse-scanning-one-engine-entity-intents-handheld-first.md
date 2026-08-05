# ADR 0120 — Warehouse scanning: one engine, entity-typed intents, handheld-first

Status: Accepted (2026-08-05)

> Supersedes the parts of [ADR 0013], [ADR 0017] and [ADR 0107] that describe
> how a *warehouse* surface acquires a scan. The transport ladder, the
> cross-source dedupe and the single camera engine those ADRs establish are
> unchanged and still authoritative.

## Context

The 2026-08 audit of the WMS scan surfaces found the same complaint at
every level: on a phone there was often "no obvious way to scan", and when
a scan did land the operator could not tell what had happened. Underneath
that were four structural gaps:

- keyboard-wedge decoding had been re-implemented per surface,
- scan targets were registered ad hoc, so nothing enforced *what kind of
  thing* a screen expected,
- the only status affordance (`ScanStatusChip`) reported router internals
  ("Listening", "Held by …") on two of ~20 surfaces, and polled the router
  once a second to do it,
- duplicate scans and wrong-kind scans collapsed into one generic error
  tone, so a mis-scan was indistinguishable from a rejection.

## Decision

**One engine.** `KeyboardScannerDriver` is the only wedge decoder;
`useCameraDecoder` is the only camera decoder. Warehouse code never listens
to keystrokes and never opens a camera. Guarded by
`single-wedge-decoder.test.ts` and `warehouse-scan-invariants.test.ts`.

**Entity-typed intents.** A warehouse surface declares what it expects via
`useWmsScanIntent({ intent })`, where the intent is `<aggregate>.<thing>`
(`putaway.bin`, `pack.carton`, `qc.item`). The intent is the single switch:
it selects the GS1 pre-parse, the entity-kind refusal rule, the platform
`ScanIntent` used by the router's conflict detector, and — since this ADR —
the operator-facing copy. No warehouse file calls `scanRouter.register`
directly.

**Copy is derived, never written per screen.** `scanGuidance.ts` maps every
declared intent to `{ what, then }`. A guard asserts total coverage of the
intent union, so adding an intent without copy fails the build rather than
silently degrading to "Ready to scan".

**One guidance surface.** `ScanGuidance` replaces `ScanStatusChip` (kept as
a deprecated alias). It answers four questions — what to scan now, which
input is live, what just happened, what happens next — plus the last five
scans. The RF app mounts it once in `MobileWarehouseLayout`; desktop
mirrors render it inline. It observes `scanRouter.subscribe()`; the 1 s
poll is gone.

**Four outcomes, not three.** `accepted | duplicate | wrong_kind | unknown`
each get a distinct tone, haptic pattern and flash colour, so an operator
wearing gloves in a noisy aisle can tell a re-scan from a refusal without
looking at the screen.

**Handheld-first.** Every RF screen with a scan prompt exposes the camera
affordance (`scanLabel`), and single vs continuous is a visible toggle in
the RF header rather than an invisible prop. Companion pairing remains
supported and remains optional.

**Idempotent writes.** Scan-driven mutations go through the offline queue,
which carries `client_scan_id` into `wms_replay_guarded_call`. A direct
`supabase.rpc` from an RF scan screen is a guard failure.

## Consequences

- A new warehouse scan surface is: pick an intent, add its copy, mount a
  sanctioned field, pass `scanLabel`. Guidance, feedback, history, camera,
  wedge, pairing and idempotency all come for free.
- The guards are the contract. `wms-scan-prompt-coverage.test.ts` pins
  affordance and guidance presence; `warehouse-scan-invariants.test.ts`
  pins the router seam, the decoder monopoly and queue idempotency;
  `scan-guidance.test.ts` pins copy coverage and the notification seam.

## Out of scope

- `MobileMyWork` has no scan prompt of its own (it dispatches to tasks that
  do), so it intentionally renders no camera affordance — a button whose
  decode lands nowhere is worse than none.
- Undo beyond the read-only history strip: only actions with an existing
  reversible RPC will get it, one at a time.
- `MobileScannerPage` (companion cockpit) keeps its device-side pipeline,
  per ADR 0107.
