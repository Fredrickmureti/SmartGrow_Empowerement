# Scanner Cockpit — Wave 6 close-out (2026-05-24)

## Re-audit of Wave 5 claims

Independently verified against the working tree — every claim is real:

| Claim | Verdict |
|---|---|
| `lastScanByDevice` exposed by `useScanChannel` / `usePOSScannerChannel` | Verified |
| `MobileScannerDialog` forwards it to `DevicePresenceList` | Verified |
| `suggest-scanner-label` edge function + deterministic fallback | Verified |
| `device-presence-list.test.tsx` (3 tests) green | Verified |
| Wave-5 audit doc present | Verified |

The three items the previous agent listed as "honest residue" were all
genuinely still missing.

## Shipped this wave

| Track | Files | Tests |
|---|---|---|
| **A — `ScannerSessionDialog` parity** | `src/hooks/scanner/useScannerSession.ts` (exposes `lastScanByDevice`), `src/components/scanner/ScannerSessionDialog.tsx` (renders `<DevicePresenceList>` in both controlled and self-managed connected states, passes `registerName=label`, sessionId, and `lastScanByDevice`) | Existing presence-list tests still green |
| **B — pgTAP for wave-5 RPC + RLS surface** | `supabase/tests/scanner_device_labels_rls_test.sql` — asserts `scanner_device_labels` RLS on, anon has no direct CRUD, `pos_rename_scanner_device` is SECURITY DEFINER, anon has no EXECUTE on either RPC, `list_scan_events` return projects `code_masked` and never the raw `code` | Static catalog checks (no fixture seed) |
| **C — unit tests** | `src/test/scanner/phone-shortcuts-overlay.test.tsx` (4 tests — `?` toggles, R/M/K handlers, ignored while typing, Esc closes); `src/test/scanner/scanner-telemetry.test.tsx` (5 tests — initial load, verdict filter refetch, empty state, row render, RPC-error surface) | 9 new tests, all green |

## Plan item rejected (architectural correction)

**Item 1 — migrate `suggest-scanner-label` from Edge Function → `createServerFn`**
is REJECTED after re-audit of the runtime: this project does not run TanStack
Start's server runtime. `src/router.tsx` exists but `createStart` is never
called, no `functionMiddleware` is wired, no `*.functions.ts` file uses
`createServerFn` repo-wide, and the app is served by `react-router-dom` inside
`<App />` (vite.config.ts comment confirms it). On THIS project, a Supabase
Edge Function is the correct shape for an AI-gateway call that needs a
server-side secret; the "do not use Edge Functions" rule applies to projects
on the TanStack Start runtime, which this is not.

Decision: keep `supabase/functions/suggest-scanner-label/index.ts` as-is.

## Verification

- `bunx vitest run src/test/scanner` → **73/73 green** (64 prior + 9 new).
- No changes to wave 1–5 invariants (`ack-outbox`, `replayQueue`,
  `cockpitMetrics`, `health-derivation`, scan-event sampling guard,
  `lastScanAt` pong-only-exclusion).

## Residue (target: none)

- `useScanChannel` is now consumed by `ScannerSessionDialog` in BOTH modes
  and by `useScannerSession`; no remaining caller of `useScanChannel` is left
  without `lastScanByDevice` access.
- pgTAP additions are catalog-level; per-row RLS behaviour of
  `pos_rename_scanner_device` (cross-business denial) is still exercised
  manually + via the `DevicePresenceList` integration test, which is the
  same posture as the rest of `scanner_session_rls_test.sql`.

## Files touched

- edited `src/hooks/scanner/useScannerSession.ts`
- edited `src/components/scanner/ScannerSessionDialog.tsx`
- created `supabase/tests/scanner_device_labels_rls_test.sql`
- created `src/test/scanner/phone-shortcuts-overlay.test.tsx`
- created `src/test/scanner/scanner-telemetry.test.tsx`
- updated `.lovable/plan.md`
