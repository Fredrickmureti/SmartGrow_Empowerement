# ADR 0037 — Hardware execution topology

Status: Accepted (2026-06-17)

## Context

The platform ships to wildly different deployments: cloud-only browser
users, multi-branch POS chains using Electron at the till, and on-prem
warehouse / clinic setups where hardware lives on a LAN. A single
"render-and-print" model cannot serve all three without leaking driver
detail into UI code, breaking audit-trail propagation, or forcing
operators to install software they do not need.

## Decision

Three execution hosts, with strict ownership boundaries:

| Host | Owns | Forbidden |
|------|------|-----------|
| **Browser** | PDF/A4 print via the OS print dialog; keyboard-wedge scanners; WebUSB/WebHID/WebSerial devices the OS exposes. | Raw TCP, vendor SDKs, native HID, file-system access. |
| **Electron desktop** | Native USB, raw 9100 ESC/POS, vendor SDKs (Epson ePOS, Star, Zebra), payment-terminal SDKs, cash-drawer kicks via the bound printer. | Becoming a single point of failure for shared hardware — see LAN agent. |
| **LAN agent** | Shared hardware: network ESC/POS / label printers, biometric attendance devices, back-office label queues. | UI rendering; user-session state. |

All three hosts speak the same wire protocol: claim a row from
`hardware_command_queue` via `claim_next_business_event` /
`claim_next_hardware_command`, execute the op through a driver registered
in `DriverRegistry`, and write the result back through
`HardwareClient.exec` so the audit columns (`source_doc_type`,
`source_doc_id`, `business_event_id`, `is_reprint`) are preserved.

Leader election within a tenant browser session is handled by
`SharedCommandQueueWorker` using `BroadcastChannel`; only one tab claims
queue rows at a time, with a 60-second lease and automatic reclaim of
stale claims via `reclaim_stale_business_events` /
`reclaim_stale_hardware_commands`.

## Consequences

- UI code never imports drivers directly; it always goes through
  `hardwareClient.exec` (architecture test
  `hardware-single-chokepoint.test.ts`).
- A device can move between hosts (e.g. a thermal printer migrating from
  per-cashier Electron to a back-office LAN agent) with no UI change —
  only the driver binding in `printer_profiles` changes.
- Browser-only tenants get a degraded but functional experience: PDF
  print + camera scan. Toasts clearly say *"queued but not printed"*
  when no driver of the requested role is bound, so operators know what
  they are missing.
- The LAN agent is the migration path for biometric attendance and shared
  back-office printers. Saga handlers and role registrations are already
  in place; the transport (`services/hardware/local-agent/`) lands in a
  later wave.

## References

- `docs/architecture/HARDWARE_CAPABILITY_MATRIX.md`
- `src/services/hardware/SharedCommandQueueWorker.ts`
- `src/services/hardware/HardwareClient.ts`
- `src/components/events/BusinessSagaMount.tsx`
- Migration `20260617154327_…sql` — outbox lease + reclaim
- Migration `20260617151025_…sql` — hardware_command_queue lease + reclaim, `request_reprint` RPC

## Addendum 2026-06-17 — Multi-branch scope + Biometrics phase 1

1. **Branch-scoped claim.** `claim_next_hardware_command` and
   `claim_next_business_event` both accept an optional `p_branch_id`.
   The renderer-side workers (`SharedCommandQueueWorker`, `BusinessSaga`)
   pass `currentBranch?.id` from `useBranches()`. A NULL branch means
   "any branch" — used by single-branch tenants and by org-scoped admin
   tools. Multi-branch tenants are guaranteed branch isolation at the
   claim step.
2. **Lot-aware labels.** `printLabelByTemplate` now accepts
   `lotNumber` / `expiryDate` / `manufactureDate` and merges them into
   `vars` as the `{{lot_number}}`, `{{expiry_date}}`,
   `{{manufacture_date}}` tokens. The GRN saga handler fan-outs one
   `shelf_edge` print per lot.
3. **Biometrics — phase 1: protocol only.** The LAN-agent wire contract
   (`BiometricDeviceHeartbeat`, `BiometricAttendanceEvent`,
   `BiometricEnrollRequest`) lives in
   `services/hardware/local-agent/protocol.ts`. Vendor SDK adapters
   (ZKTeco / Suprema / Hikvision) ship in a later wave once SDK access
   is procured; until then the protocol can be exercised by a synthetic
   agent for integration tests.
