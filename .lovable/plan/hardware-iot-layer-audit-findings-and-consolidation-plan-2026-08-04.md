# Hardware & IoT Layer — Audit Findings and Consolidation Plan

## Verdict

The architecture is roughly 80% correct and does not need a rewrite. There is one
authoritative registry, one document print pipeline, and one hardware chokepoint.
What is broken is **readiness**: the platform has a cloud-relay execution path but
POS asks a *local* question ("is a device connected to this browser?") to decide
whether printing is possible. Two components also fight over the same in-memory
device list and auto-connect it.

This is architectural drift in the readiness/ownership layer, not a printer bug.

## What is already correct (verified, keep it)

- **One device registry.** `public.device_assignments`, resolved server-side by
  the `resolve_device` RPC. No module keeps its own printer table.
- **One document pipeline.** `PrintService.printDocument` → `printing/policy` →
  `printing/jobs` (durable `print_jobs` ledger) → `printing/render` →
  `printing/dispatch`. Documented as "no side doors", and the code holds.
- **One hardware seam.** `printing/dispatch.toDevice` → `execForIntent` →
  `resolve_device` → `hardwareClient.execAssignment`. Applications express intent
  (`receipt`, `label`, `a4_document`); they never name a device or transport.
- **A real remote-execution path.** `RelayTransport` enqueues `edge_jobs` for a
  workstation and awaits the result over Realtime; the agent claims jobs on a
  1.5s poll (`edge/routes/agent-poll.ts`) and stamps `workstations.last_seen_at`
  as its heartbeat. This is why a phone can print on another machine's agent.
- **A server-side drain.** `dispatch-print-jobs` claims queued `print_jobs`
  (SKIP LOCKED, back-off, DLQ) and routes to the same workstation relay.
- Business-event modelling, idempotency keys, audit log (`hardware_exec_log`),
  and the operator workspace (print queue, diagnostics) already exist.

## Root cause of "No printer connected" in POS

1. `usePrinterStatus` / `printerStatusSnapshot` decides availability purely from
   `hardwareClient.devices.getStatuses()`, which in a browser reads the
   **renderer adapter's local connection state**. A relay-routed printer owned by
   a different machine's agent is never "connected" locally, so the count is 0.
2. `ReceiptPreviewBody` compounds this with a second readiness source —
   `useHardwareProxy(...).printerStatus()` plus `isRoleAvailable("receipt_printer")` —
   again local-only.
3. Invoice and label printing never consult either probe. They go straight to
   `PrintService` → relay, which works. Hence the module-by-module difference.
4. **Two writers race over the singleton adapter registry.** `EdgeRelayMount` loads
   workstation-scoped rows and calls `connectAll()`; `useHardwareProxy` loads
   register-scoped rows and calls `connectAll()` independently. The later mount
   overwrites the earlier list — and `EdgeRelayMount` calls
   `loadAssignments([])` + `disableRelay()` whenever it cannot pick a workstation.
5. `EdgeRelayMount` picks the workstation **org-wide** (`limit 5`, freshest
   `last_seen_at`, no liveness window, no branch/register scope). A second or
   stale workstation can capture routing for everyone.

Correct model: readiness is a **registry + heartbeat** question answered from the
cloud (is a device bound for this intent, and is its owning workstation alive?),
not a local transport question.

## Ownership model to enforce

| Concern | Single owner |
|---|---|
| Physical discovery | IoT agent (and Electron main). Browsers never scan. |
| Registration | Agent publishes → `device_assignments` |
| Identity, auth, session | `workstations` row + workstation token, verified by `authorizeWorkstation` |
| Heartbeat / liveness | Agent poll stamping `workstations.last_seen_at` |
| Capability | `device_assignments.capabilities` (+ `runtimeCapability()` for the *local* runtime only) |
| Printer selection | `resolve_device` RPC — server-side, only |
| Job ledger | `print_jobs` |
| Transport queue | `edge_jobs` (relay) / DeviceManager queue (Electron) |
| Execution | Agent / Electron drivers |
| Readiness answer | one new service, see below |

## Plan

### Phase 1 — One readiness service (fixes POS)

Add `src/services/hardware/readiness.ts` exposing `resolveIntentReadiness(intent, ctx)`
which answers from the platform, not the local transport:

- Is a `device_assignments` row bound for this intent (via `resolve_device`)?
- Is the owning workstation alive (`last_seen_at` inside the liveness window)?
- Or is a local runtime (Electron/loopback agent) able to serve it directly?

Returns a typed state: `ready` | `no_device_bound` | `workstation_offline` |
`degraded` | `local_only_unavailable`, each with operator-facing copy.

Rewire `usePrinterStatus`, `usePrintWithFallback` and `ReceiptPreviewBody` to this
single source, and delete the local-only availability logic in POS. Keep
`getStatuses()` for diagnostics — it stays a *runtime* probe, not a readiness probe.

### Phase 2 — One connection owner

- Make `EdgeRelayMount` the only component that writes the adapter registry and
  the only caller of `connectAll()`; strip both from `useHardwareProxy`, leaving
  it a read-only status/action facade.
- Scope workstation selection by branch/register with an explicit liveness window,
  and stop clearing assignments/relay when a query is merely still loading.
- Remove browser-initiated connect side effects from Hardware Settings pages:
  browsers observe, they do not negotiate hardware ownership.

### Phase 3 — One dispatch story, documented

Both dispatch paths (foreground `PrintService` and the `dispatch-print-jobs`
drain) are legitimate — one is synchronous, one is recovery — but only one is
documented. Update `docs/architecture/HARDWARE_RUNTIME.md` to include the relay
and queue drain as first-class, and record the readiness contract and the
single-connection-owner rule in an ADR.

### Phase 4 — Failure semantics

Replace the flat "No printer connected" with the readiness states from Phase 1:
device unbound → bind CTA; workstation offline → "the till PC running the agent is
offline"; transport error → retry/PDF fallback with the job still in the ledger.

### Phase 5 — Guard tests

- No file outside `readiness.ts` may derive print availability from `getStatuses()`.
- `connectAll()`/`loadAssignments()` callable from exactly one module.
- Workstation selection must apply a liveness window.

## Notes

- No new tables and no schema changes are required; `workstations`,
  `device_assignments`, `print_jobs`, `edge_jobs` already model the lifecycle.
- Nothing here changes Electron behaviour; the desktop path already resolves
  readiness correctly through DeviceManager.
