# Scanner Cockpit — Wave 7 close-out (2026-05-25)

## Re-audit of Wave 6 claims

Independently verified against the working tree — every Wave-6 claim is real:

| Claim | Verdict |
|---|---|
| `useScannerSession` exposes `lastScanByDevice` + `ScannerSessionDialog` renders `<DevicePresenceList>` in both modes | Verified |
| `supabase/tests/scanner_device_labels_rls_test.sql` (catalog pgTAP) | Verified |
| `phone-shortcuts-overlay.test.tsx` (4 tests) | Verified |
| `scanner-telemetry.test.tsx` (5 tests) | Verified |
| Scanner suite `bunx vitest run src/test/scanner` → 73/73 | Reproduced (73/73) |
| `ScannerTelemetry` page wired at `/pos/scanner-telemetry` | Verified |
| `scanner_session_rls_test.sql` exists | Verified |
| Existing arch guards (`scan-event-sampling`, `pos-single-scanner`, `realtime-scan-channel-policies`, `scanner-session-mode`, `barcode-enrollment-scanner-discipline`) | Verified |

Wider re-audit of the cockpit surface (status band, metrics row, ACK band,
recent rail filters, manual reconnect, queue chip, 5 typed revoke reasons,
audio mute, re-pair deep-link, telemetry page) — all present and behave
as the Wave-1..6 audit docs describe.

## Real residue I found and closed

### R1 — `replayQueue` helpers were dead code in production

`src/services/scanner/replayQueue.ts` exports `enqueueScan` / `drainQueue`
with the cap-50, drop-oldest, one-shot-toast contract pinned by
`src/test/scanner/replay-buffer.test.ts`. But `MobileScannerPage`
re-implemented the same logic inline:

- Drain block (old lines 326–353): manual `splice(0, length)` + manual
  `queueFullToastShownRef.current = false`.
- Enqueue block (old lines 473–487): manual `q.length >= 50` check +
  manual `q.shift()` + manual toast latch flip.

Risk: the unit-tested contract and the actually-shipped behaviour can
drift silently. Wave-2 explicitly extracted the helpers so the page
would consume them — that wiring was never done.

**Fix.** `src/pages/pos/MobileScannerPage.tsx`:

- Import `enqueueScan`, `drainQueue`, `QueuedScan` from
  `@/services/scanner/replayQueue`.
- Replace the page-local `queueFullToastShownRef` with a
  `queueStateRef = useRef<{ fullToastShown: boolean }>(...)` matching the
  helper signature.
- Drain path now calls `drainQueue(pendingScansRef.current, queueStateRef.current)`.
- Enqueue path now calls `enqueueScan(...)` and uses
  `res.shouldNotifyFull` / `res.depth` to drive the toast and chip.

No semantic change. The 6-test `replay-buffer.test.ts` suite continues
to pin the contract; production now executes the same code path.

### R2 — Missing architecture guard for raw control-event `channel.send`

Wave-4 audit said: "architecture guard test forbidding raw
`channel.send(...ack...)` outside the two hook files — should be added
before merge". Never added.

**Fix.** New `src/test/architecture/scanner-ack-send-discipline.test.ts`:

- Walks `src/**/*.{ts,tsx}`.
- Matches every `.send({ … })` payload and inspects the `event: "<name>"`
  literal inside it.
- Fails if `<name>` is one of `ack` / `revoke` / `ping` in any file
  outside the allow-list (`useScanChannel.ts`, `usePOSScannerChannel.ts`,
  the guard itself).
- `pong` is intentionally NOT covered — `MobileScannerPage` legitimately
  replies to phone-side `ping` broadcasts.

Current tree passes (no offenders today). The guard prevents future
regressions where a new feature broadcasts an ACK from outside the
sanctioned desk hooks and silently breaks the ACK-band contract, RTT
telemetry, typed revoke reasons, or mirrored audio feedback.

## Verification

- `bunx vitest run src/test/scanner src/test/architecture/scanner-ack-send-discipline src/test/architecture/scan-event-sampling`
  → **75/75 green** (73 scanner + 1 new control-event guard + 1
  pre-existing `scan_events` insert guard).
- No changes to Wave-1..6 invariants
  (`ackOutbox`, `replayQueue` contract, `cockpitMetrics`,
  `health-derivation`, scan-event sampling guard, `lastScanAt`
  pong-only exclusion, ACK wire schema).
- Repo-wide `bunx vitest run` has 22 unrelated pre-existing failures
  (warehouse-stock helper allow-list, inventory forecast, etc.) — none
  in scanner or POS surface. They are not regressed by this wave.

## Carried forward (rejected after re-audit)

- **Migrate `suggest-scanner-label` Edge Function to `createServerFn`** —
  rejected. This project is Vite + react-router-dom, not TanStack Start
  (no `createStart`, no `functionMiddleware`, no `*.functions.ts`). Edge
  Function is the correct shape.

## Out of scope (ADR-0013)

- Native Zebra DataWedge / Honeywell SwiftDecoder SDKs.
- AI auto-naming from barcodes.

## Files touched

- edited `src/pages/pos/MobileScannerPage.tsx`
- created `src/test/architecture/scanner-ack-send-discipline.test.ts`
- updated `.lovable/plan.md`
- created `docs/audit/2026-05-25-scanner-cockpit-wave-7.md`
