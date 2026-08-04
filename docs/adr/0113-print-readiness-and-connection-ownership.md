# ADR-0113: Print readiness is a registry + heartbeat question, and hardware connections have one owner

Date: 2026-08-04
Status: Accepted

## Context

POS reported "No printer connected" while Invoice and Label printing worked
from the same browser — including remotely, against a printer plugged into a
different machine.

Both symptoms had the same root: readiness and execution disagreed about
what "connected" means.

- Execution is platform-wide. `PrintService` → `dispatch.toDevice` →
  `execForIntent` → `resolve_device` → `hardwareClient`, and when the
  browser cannot reach loopback, `RelayTransport` queues an `edge_jobs` row
  that a remote IoT agent claims on its 1.5 s poll. A phone can therefore
  print on the till's printer.
- Readiness was local. `usePrinterStatus` / `printerStatusSnapshot` derived
  availability from `hardwareClient.devices.getStatuses()`, which reports
  the **renderer adapter's own** connection state. A relay-routed printer is
  never "connected" there, so any surface that gated on it refused to print.
  Invoice and label flows never consulted the probe, so they worked.

A second defect compounded it: `EdgeRelayMount` and `useHardwareProxy` both
wrote the singleton adapter registry and both called `connectAll()`. The
later mount overwrote the earlier device list, and `EdgeRelayMount` cleared
assignments and disabled the relay whenever it could not pick a workstation
— including while its own query was still loading. Workstation selection
was org-wide with no liveness window, so a stale workstation could capture
routing for every user.

## Decision

1. **One readiness service.** `src/services/hardware/readiness.ts` answers
   `resolveIntentReadiness(intent)` from the registry (`resolve_device`) and
   the workstation heartbeat (`workstations.last_seen_at` within
   `WORKSTATION_LIVENESS_WINDOW_MS`, kept equal to `RelayTransport`'s
   fail-fast window), falling back to the local runtime only for
   assignments with no owning workstation. Every UI gate goes through it,
   directly or via `useIntentReadiness` / `usePrinterStatus`.

2. **`getStatuses()` is diagnostics.** It may not be used to decide whether
   printing is possible.

3. **Typed failure states, not a flat warning.** `no_device_bound`,
   `workstation_offline`, `degraded`, `local_only_unavailable`, `unknown` —
   each carries operator-facing copy naming the actual blocker.

4. **One connection owner.** `EdgeRelayMount` is the only caller of
   `devices.loadAssignments()` and `devices.connectAll()`. It filters
   workstations by liveness and never clears state while a query is in
   flight. `useHardwareProxy` becomes a read-only status/action façade.

## Consequences

- POS, Invoice and Label now agree on availability, and remote printing is
  reflected honestly in the UI.
- Opening hardware settings in one session no longer disturbs another.
- Readiness costs two indexed queries instead of a transport probe; it is
  cached and polled on the agent heartbeat cadence (15 s).
- Electron behaviour is unchanged: those assignments have no workstation and
  resolve through the local runtime, and the renderer registry calls are
  no-ops there.

Guard: `src/test/architecture/hardware-readiness-single-source.test.ts`.
