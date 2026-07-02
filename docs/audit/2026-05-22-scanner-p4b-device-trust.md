# Scanner P4b — Device Trust + Silent Reclaim (closeout)

Date: 2026-05-22  
Wave: P4b (last open item in the scanner-architecture plan).

## Re-audit of prior waves (zero-trust)

| Claim | Evidence | Verdict |
|---|---|---|
| P2 — per-intent replay policy | `src/services/scanner/replayPolicy.ts`, `src/contexts/SalesScanInbox.tsx`, `src/components/sales/SalesScanReviewDrawer.tsx`, `src/test/scanner/replay-policy.test.ts` | Shipped, locked |
| P4a — `localStorage` device id | `src/services/scanner/deviceIdentity.ts` (key `pos.scanner.deviceId.v2`), `src/test/scanner/device-id-persistence.test.ts` | Shipped, locked |
| P5 — DIALOG_READY + ScanIntentBoundary + non-POS namespace cleanup | `src/services/scanner/dialogReadyBus.ts`, `src/components/scanner/ScanIntentBoundary.tsx`, `src/test/scanner/dialog-ready-bus.test.ts`, `src/test/architecture/scanner-ack-send-discipline.test.ts` | Shipped, locked |
| P3 — connection state machine + row-update revocation | `useScannerConnectionMachine.ts`, `useScannerSessionRevocation.ts`, `connection-machine.test.ts` | Shipped, locked |

No regressions detected in any of the four. The plan file's prior claims
for P2/P4a/P5 are now grep-verified end-to-end.

## What P4b shipped

### Migration

`scanner_device_trust` table + three SECURITY DEFINER RPCs:

- `scanner_issue_trust(p_session_id, p_device_id, p_device_label)` — mints
  a 32-byte random base64 token, stores `sha256(token)` + first-8-char
  prefix, returns the raw token exactly once. Caller must be in the
  session's organization with role `super_admin | owner | admin | cashier
  | staff`.
- `scanner_reclaim_session(p_device_id, p_trust_token)` — phone-callable.
  Rejects with typed errors: `trust_invalid`, `trust_revoked`,
  `trust_expired` (>30d last_seen), `trust_unauthenticated`. On success
  inserts a fresh `scanner_sessions` row mirroring the trusted device's
  `business_id / branch_id / label / target_kind`, bumps `reclaim_count`,
  rotates `trust_token`, returns connection envelope + `new_trust_token`.
- `scanner_revoke_trust(p_device_id, p_reason)` — admin/operator. Sets
  `revoked_at` + `revoked_reason`; no-op if nothing matches (does not
  leak existence).

RLS: `SELECT` for org members with one of the five roles + `is_active`;
`INSERT/UPDATE/DELETE` blocked by a RESTRICTIVE `USING (false)` policy.
All mutation flows through the RPCs.

### Client wiring

- `src/services/scanner/deviceIdentity.ts` — added
  `TRUST_TOKEN_KEY`, `getTrustToken`, `setTrustToken`, `clearTrustToken`
  (graceful on storage shims without `removeItem`).
- `src/pages/pos/MobileScannerPage.tsx` — claim effect now branches:
  - **No URL token + stored trust token** → call `scanner_reclaim_session`
    silently. On `trust_invalid|revoked|expired` clear the local token
    and surface the QR fall-through. On success, populate `claim` and
    skip the pairing UI entirely.
  - **URL token (fresh QR)** → existing `pos_claim_scanner_pairing` /
    `claim_scanner_session_pairing` flow, then immediately call
    `scanner_issue_trust` and persist the returned token. Issue failure
    is non-fatal (degrades gracefully to QR-only on next refresh).
- `useScannerSessionRevocation` callback also `clearTrustToken()`s so an
  out-of-band revoke does not loop reclaim attempts.
- `src/components/scanner/ScannerSessionDialog.tsx` — added the
  `TrustedDevicesPanel` (admin-side): lists active trust rows
  (label, token prefix, reclaim count, last seen) with per-device
  Revoke button calling `scanner_revoke_trust`.

### Locked invariants

- `src/test/scanner/trust-token-storage.test.ts` — get/set/clear
  round-trip + back-compat with shim storage.
- `src/test/architecture/scanner-device-trust-rpc-discipline.test.ts` —
  no `src/` file may `.insert/.update/.delete/.upsert` against
  `scanner_device_trust`; only `.select` is allowed. All mutation flows
  through the three RPCs.

New tests: 4 cases across 2 files. Both pass.

Pre-existing failing suites (unrelated to P4b, present before this turn):
`supabase-client-auth-config`, `warehouse-stock-reads-go-through-helper`,
and 15 others — none touch scanner code.

## Out of scope (explicit)

- Cross-browser trust portability (token is per-browser by design).
- Renaming POS-namespace RPCs (`pos_create_scanner_pairing` etc.).
- A formal `scan_events` audit table for silent-reclaim attempts —
  current path uses `console.info` markers (`silent_reclaim_ok`,
  `silent_reclaim_failed`, `issue_trust_failed`) consumable by the same
  telemetry harness as the rest of the cockpit.

## Status

P4b → **shipped**. Scanner-architecture plan (P1 → P5 → P4b) is now closed.