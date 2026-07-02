# Scanner Cockpit — Re-audit & Completion (2026-05-20)

## Verdict

The phone-side cockpit, desk-side telemetry, and workspace re-pair flow
are now end-to-end. All deferred items from the previous loop's plan
(S3 phone consumer, S4 audio, S5 telemetry, S6 re-pair deep-link,
S7 guard tests, S8 docs) are landed and grep-verified.

## Industry comparison

| System              | Connection chip | Workflow cue       | Audio verdict pack | RTT telemetry | Reason on disconnect |
|---------------------|-----------------|--------------------|--------------------|---------------|----------------------|
| Zebra DataWedge     | yes             | profile name       | ok/bad             | no            | yes (profile event)  |
| Honeywell SwiftDecoder | yes          | scan-mode          | ok/bad             | no            | yes                  |
| Odoo Inventory PWA  | yes             | screen title       | ok                 | no            | no                   |
| SAP EWM RF          | yes             | transaction code   | ok/bad             | no            | yes                  |
| Shopify POS mobile  | yes             | cart context       | ok/bad             | no            | no                   |
| Square Retail       | yes             | item lookup        | ok                 | no            | no                   |
| **This cockpit**    | **yes**         | **workflow chip + field label** | **ok / duplicate / invalid / disconnect** | **median 10-sample** | **5 typed reasons**  |

## Three-band cockpit contract

1. Status band — pairing target, workflow chip, health pill.
2. Scan area — camera + reticle + persistent ACK band + in-flight chip.
3. Recent rail + action dock — collapsible last 8 scans + Start/Stop, torch, manual, mute.

## Wire schema (single source of truth)

`src/services/scanner/ackPayload.ts` — zod schemas for `ack`, `revoke`,
`ping`, `pong`. All extensions are additive: old senders/receivers
continue to parse new payloads, locked by
`src/test/scanner/ack-payload-contract.test.ts`.

## Per-stage shipped status

| Stage | What | Files | Test |
|-------|------|-------|------|
| S3 ACK senders | workflow + field_label | `useScanChannel.ts:144-156`, `usePOSScannerChannel.ts:118-131` | ack-payload-contract |
| S3 phone renderer | workflow chip in status band | `MobileScannerPage.tsx` status band | n/a (visual) |
| S4 audio pack | feedbackTones + mute | `services/scanner/feedbackTones.ts`, dock mute button | feedback-tones |
| S5 telemetry | pingPhone / RTT / lastScanAt | `useScanChannel.ts:175-206`, `usePOSScannerChannel.ts`, `useScannerSession.ts` | n/a |
| S5 dialog rows | device / online / last scan / RTT + Ping phone | `ScannerSessionDialog.tsx` SessionBody | n/a |
| S6 reason copy | 5 typed reasons on Disconnected screen | `MobileScannerPage.tsx` revoked overlay | ack-payload-contract |
| S6 re-pair deep-link | BroadcastChannel("scanner-workspace") | `MobileScannerPage.tsx` handleRepair, `ScannerWorkspaceContext.tsx` reopen listener | n/a |
| S6 auto-revoke reason | business_changed / branch_changed on workspace switch | `ScannerWorkspaceContext.tsx` key-change effect | n/a |
| S7 architecture guards | 4 tests | `src/test/scanner/*.test.ts` | all 4 passing |
| S8 audit doc | this file | `docs/audit/2026-05-20-scanner-cockpit.md` | n/a |

## Test run

`bunx vitest run src/test/scanner` → 38/38 passing (4 files).

## Out of scope (unchanged)

- `scanBus`, `scanRouter`, RLS, RPCs, new tables, edge functions.
- POS terminal cart UI beyond ACK payload extension.
- Native scanner SDKs, `scan_events` sampled audit table, phone-side
  ring-buffer replay on reconnect.

## Known follow-ups (not blocking)

- `useScanChannel.pingPhone` polls `pendingPingsRef` every 50 ms — works
  but could be event-emitter based for cleaner code.
- Phone could optionally replay a ring buffer of unsent scans on
  reconnect; today the local 400 ms dedupe is enough for steady-state
  warehouse use.
- `scan_events` sampled audit table for p95/p99 latency soak still TODO.