# Hardware/Print Pipeline: Verification Verdict and Consolidation Plan

## Verdict on the previous refactor

Partially completed. The *resolution* half was unified (`resolve_device` RPC → `resolveDeviceForIntent` → `execForIntent` → `dispatch.toDevice`). The *execution* half was not: the resolved device is thrown away one line before the bytes leave. There are still two device registries and two status vocabularies.

## Evidence (all verified this session)

Registry (`device_assignments`, live rows):

```text
role             transport  status   workstation_id   enabled
a4_printer       network    online   3cf8f920...      true
label_printer    network    online   NULL             true
receipt_printer  network    online   NULL             true
```

Ledger (`print_jobs`, invoice print at 23:28 today):

```text
doc_type=sales.invoice medium=escpos  status=failed
  last_error="No device assigned for role: receipt_printer"
doc_type=sales.invoice medium=pdf     status=queued (never settled)
```

`edge_jobs`: no print rows at all — the newest rows are `role=test` from Aug 3. Nothing has been relayed to the agent since the refactor.

### Defect 1 — `execAssignment` discards its own routing decision
`src/services/hardware/HardwareClient.ts:679-707` computes `routeTransport(assignment)`, logs it, then calls `execAny(assignment.role, ...)`. `execAny` does a **role** lookup in `BrowserHardwareAdapter`'s in-memory registry. The `assignment.id` the server resolved is never used. So the canonical resolver picks a device and the renderer then re-picks one by role from a different registry — the exact duplication the refactor was meant to delete.

### Defect 2 — the renderer registry is empty by construction
`src/components/hardware/EdgeRelayMount.tsx:130-142` is the sole writer of that registry and filters on `workstation_id = <live workstation>` **and** `status in ('ok','unknown')`. Neither filter matches reality: two rows have `workstation_id = NULL`, and `DeviceRegistryCard.tsx:273/329/347` writes `status = 'online'`, which the filter excludes. Result: zero devices loaded, so every role lookup returns "No device assigned for role: X". This is the single proximate cause of both reported symptoms (invoice escpos job failing, label reporting "No printer assigned" via `readiness.ts:164` / `usePrinterStatus.ts:134`).

### Defect 3 — the UI reports success for a failed dispatch
`src/pages/Invoices.tsx:359-366` toasts "Print dispatched ... queued to N target(s)" without reading `result.success` / `result.error`, even though `printDocumentIntent` returns both. That is why the ledger says `failed` and the operator sees green.

### Defect 4 — non-print targets are orphaned in the ledger
`PrintService.printDocumentIntent` skips rows whose disposition is not `print` and never settles them, leaving permanent `queued` rows (observed: the `download` target from every invoice print).

### Defect 5 — no owner binds a device to a workstation
Nothing in the app writes `device_assignments.workstation_id`; `EdgeRelayMount` and `useInventoryLabelPrinter` only read it. Devices enrolled through the ERP Hardware page are therefore unroutable to any agent.

## What to change

1. **Make the assignment the execution unit.** Add `execAssignmentDirect(assignment, op, payload)` to `HardwareClient` that switches on `RouteDecision.kind` and dispatches by **assignment id**: `electron_native` → IPC with the assignment; `local_agent` → `agentClient` (relay first, loopback fallback) using the assignment's own `config.ipAddress/port` or vendor/product; `webusb`/`webhid` → those transports. Delete the `execAny(role, ...)` fallback from `execAssignment`. Role-keyed `exec()` survives only for legacy scanner/scale event paths, marked deprecated and fenced by a guard test.
2. **Retire the renderer role registry as a routing authority.** `BrowserHardwareAdapter` keeps driver lifecycle keyed by assignment id; `roleAssignments` / `executeForRole` stop being reachable from the print path. `EdgeRelayMount` becomes relay-config only (workstation selection + `enableRelay`) and no longer owns a device list.
3. **One status vocabulary.** Normalise `device_assignments.status` to `online | offline | error | unknown` in a migration, align `DeviceRegistryCard` and every filter to that set, and drop the `status in ('ok','unknown')` filter entirely — `enabled` plus workstation liveness is the gate.
4. **Own the workstation binding.** The Devices page gets an explicit "Runs on workstation" selector writing `workstation_id`. A device with `transport = network|usb` and no workstation is surfaced as `unroutable` in the registry UI and by a new `readiness.ts` state, instead of silently resolving and then failing at dispatch. Backfill the two existing rows to the live workstation.
5. **Honest completion semantics.** `printDocumentIntent` returns per-target outcomes; `Invoices.tsx` and the other call sites (Estimates, Bills, CreditNotes, DeliveryNotes, SalesOrders, PurchaseOrders, ProformaInvoices, CustomerStatements, SalesReturns, PurchaseReturns, plus the `features/**/dispatch*.ts` helpers) toast from `result.success` and show the bind-device CTA on `needsDevice`. Non-print targets are settled by their own handler rather than left `queued`.
6. **Guard tests** in `src/test/architecture/`: no module outside `HardwareClient` may call `execAny`/`executeForRole`; every `printDocumentIntent` call site must branch on `result.success`; `EdgeRelayMount` must not call `loadAssignments`.

## Verification before hand-back

Re-run an invoice print, a label print and a POS receipt against the `localhost:9100` emulator and confirm, for each: one `edge_jobs` row reaching `done`, the matching `print_jobs` row reaching `acked`, bytes at the emulator, and a toast that matches the ledger.

## Out of scope

No changes to the agent, the pairing/token lifecycle, `resolve_device` tie-break semantics, or the document render pipeline — all three were verified correct.