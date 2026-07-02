# Hardware, Printing & Document Architecture — Independent Re-Audit

**Date:** 2026-06-10
**Predecessor:** `docs/audit/2026-06-09-hardware-wave-10.md` (Wave 10 + continuation pass)
**Method:** Treat every Wave-10 claim as unverified. Re-derive from source via four parallel deep-trace subagents (drivers/transports, rendering/routing, discovery/agent, app×role matrix) plus direct line-level spot-checks.

---

## 0. Executive Summary

The architecture is **structurally sound** at the chokepoint, registry, command-router, and saga layers. Wave 10's headline claims (PrintService retired, kitchen-ticket first-class, per-role mutex, batched exec log, terminal-qualified saga key, device-aware hook adopted by POS surfaces) are **verified line-for-line and not stale**.

However, several **production-blocking gaps** and **multiple medium-severity inconsistencies** exist that the prior audit either missed or de-scoped. The headline finding is that the platform is **POS-centric with bolt-ons**, not a truly cross-app hardware platform in the Odoo sense — Sales, Purchases, and Finance still print through a *shadow path* (`useDocumentPrint` → `PrintPreviewDialog`) that bypasses `PrintClient`/`hardwareClient` entirely.

| Area | Verdict |
|---|---|
| Single source of truth (`device_assignments`) | 🟢 Confirmed |
| Single chokepoint (`hardwareClient`) | 🟡 Confirmed but arch-test gap (see §5.B) |
| Driver/transport contract compliance | 🟢 100% |
| Per-role mutex (Wave 9d.9) | 🟢 Confirmed |
| Batched exec log + saga-key qualification | 🟢 Confirmed |
| Kitchen-ticket first-class path | 🟢 Confirmed end-to-end |
| Cross-app print routing | 🔴 Shadow paths in Sales/Purchases/Finance |
| Plug-and-play readiness | 🔴 Manual save + reload required for every role |
| Dead-letter operator visibility | 🔴 Zero UI surface |
| Bluetooth transport | 🔴 Hardcoded "not implemented" — silently fails |
| `LineDisplayDriver` Electron path | 🔴 Broken (electronBridgeDead) |
| Agent auth | 🟠 Non-constant-time compare + wildcard CORS |
| Terminal-ID collision risk | 🔴 `localStorage` miss → all terminals collide on `"default"` |
| ZPL renderer auth gating | 🔴 Org/entitlement bypass on `format=zpl` |

---

## 1. App-installer × Hardware-Role Matrix

Apps under `src/apps/` (Odoo-style installable modules). Print triggers traced to every file.

| App | Roles consumed | Documents printed | Print trigger sites | Scans? | Routes through chokepoint? |
|---|---|---|---|---|---|
| **pos** | receipt_printer, kitchen_printer, cash_drawer, customer_display, payment_terminal, barcode_scanner | pos_receipt, kitchen_ticket, payment_receipt | `POSTerminal.tsx`, `KitchenOrderTicket.tsx`, `TransactionHistoryDialog.tsx`, `POSSettings.tsx` | ✅ scanBus | ✅ |
| **inventory** | label_printer, barcode_scanner | inventory_label | `Products.tsx:220` (handlePrintLabel), `BarcodeEnrollment.tsx:99` | ✅ scanBus | ⚠️ Label bytes via `hardwareClient.printLabelBytes` (good), but **ZPL template hardcoded in the React component**, bypassing `generate-document` policy/audit |
| **sales** | barcode_scanner only | invoice, estimate, sales_order, delivery_note, sales_return | `Invoices.tsx:187`, `SalesOrders.tsx:97` → `useDocumentPrint` → `PrintPreviewDialog` | ✅ `SalesScanContext` | 🔴 **SHADOW** — `PrintPreviewDialog` uses the browser/OS print dialog; never reaches `printClient` or `hardwareClient`; not in audit log |
| **purchases** | — | purchase_order, GRN | `PurchaseOrders.tsx:301` → `useDocumentPrint` → `PrintPreviewDialog` | ❌ | 🔴 **SHADOW** (same as Sales). Additionally, **GRN is not registered** in `generate-document`'s `FETCHER_MAP` (only `purchase_order` is) — any call with `documentType: 'goods_received_note'` returns HTTP 400 |
| **finance** | — | invoice, credit_note, proforma, payment_receipt | `CreditNotes.tsx`, `ProformaInvoices.tsx`, statements pages | ❌ | 🔴 **SHADOW** |
| **platform** | all (admin/diagnostics) | none (test-pings only) | `HardwareDevices.tsx`, `DeviceWizard.tsx`, `HardwareDiagnostics.tsx`, `HardwareTopology.tsx` | ❌ | ✅ |
| contacts, crm, hr, projects, reports, sms, studio, timesheets, me | none | none | — | ❌ | n/a |

### Cross-cutting infrastructure verdict

- **Scanner (`scanBus`/`scanRouter`/`useScanTarget`)** — genuine cross-app bus. POS, Inventory, Sales all subscribe to the same kernel. Any new app gets scans for free. `useBarcodeScanner` is `@deprecated`; no live callers. ✅
- **`useDeviceForRole` + `hardwareClient`** — documented canonical pattern. Inventory `label_printer` is the only shipped non-POS example.
- **POS-only roles** — cash_drawer, customer_display, payment_terminal, scale. Scale driver exists but is **completely unwired** (no `useDeviceForRole('scale')` call anywhere in `src/`).

> **Architecture verdict:** Hardware platform is POS-centric with isolated bolt-ons. The Odoo philosophy "install app, plug hardware, go" is partially realized for scanners and inventory labels only; Sales/Purchases/Finance printing is a parallel, unaudited path.

---

## 2. Wave-10 Claim Verification (line-level)

| Wave-10 claim | Verdict | Evidence |
|---|---|---|
| `PrintService.ts` deleted | ✅ Confirmed | File absent; arch guard `src/test/architecture/no-printservice-shim.test.ts` (59 lines) enforces |
| `usePrinterStatus.ts` rewritten to read `hardwareClient.devices.getStatuses()` | ✅ Confirmed | File contains the rewrite; polling default-on in Electron |
| `printKitchenTicket` exists in `PrintClient` | ✅ Confirmed | `src/services/printing/PrintClient.ts:108` |
| `pdfUtils.generateDocumentEscPosBytes` forwards `station/course/table/paperFormat` | ✅ Confirmed | `pdfUtils.ts:233-250` |
| `KitchenOrderTicket.tsx` Print button using `printer_category` | ✅ Confirmed | Lines 27, 64-82 |
| `useResolvedPrintPolicyWithDevice` consumed by POSTerminal + POSSettings + TransactionHistoryDialog | ✅ Confirmed (3/3) | Lines 103/237, 269, 74 respectively |
| POSSettings "Will print to:" badge | ✅ Confirmed | `POSSettings.tsx:710-722` |
| `escpos/kitchen.ts` self-contained (NOT receipt-builder reuse) | ✅ Confirmed | 274 lines, zero imports from `builder.ts`/`blocks.ts` |
| `generate-document` short-circuits on `kitchen_ticket` AFTER auth/sub gating | ✅ Confirmed | Short-circuit at line 1943, auth/membership/entitlement at lines 1577–1931 |
| Kitchen-ticket golden test locks bytes | ✅ Confirmed | `src/test/printing/kitchen-ticket-golden.test.ts` exists |
| ZPL golden test | ✅ Confirmed | `src/test/printing/zpl-golden.test.ts` exists |
| `no-printservice-shim` arch guard | ✅ Confirmed | Exists and is tight |
| HardwareExecLog 2s/25-row batching, cached session id, onAuthStateChange invalidation | ✅ Confirmed | `FLUSH_INTERVAL_MS=2_000`, `FLUSH_BATCH_SIZE=25`, lines 50-57, 74-79 |
| SaleSaga key `${terminalId}:${saleId}:${step}` | ✅ Confirmed | `SaleSaga.ts:102-103`; main.ts:923-927 wires `setTerminalId` |
| HardwareTopology page registered | ✅ Confirmed | `src/apps/platform/hardware/routes.tsx` |
| Per-role mutex `DeviceManager.withRoleLock` + `CommandRouter.roleLock` | ✅ Confirmed | DeviceManager:107-113, CommandRouter:60/71-73/123, wired at bootstrap:119-122 |
| Singleton ref-counted realtime channel | ✅ Confirmed *but* | See §5.D — Electron mode opens a **second** parallel channel via `ElectronAssignmentHydrator`, defeating the ref-count goal |
| DeviceWizard at `/platform/hardware/devices/new`, 424 lines | ✅ Confirmed | Exact line count; but see §5.H for limitations |
| `pos_hardware_configs` dropped | ✅ Confirmed in code | Zero runtime refs; but a stale error-log string at `DeviceManager.ts:139` still mentions the table |

**No false claims found.** The Wave-10 doc is honest about what was changed.

---

## 3. Current Architecture Map

```text
┌──────────────────────── Renderer (React) ────────────────────────┐
│  Apps: pos · inventory · sales · purchases · finance · platform   │
│         └─ hardware UI: useDeviceAssignments / useDeviceForRole   │
│         └─ print UI:   useResolvedPrintPolicyWithDevice           │
│         └─ scan UI:    useScanTarget → scanBus/scanRouter         │
├───────────────────────────────────────────────────────────────────┤
│  CHOKEPOINT — src/services/                                       │
│    printing/PrintClient.ts  ──┐                                   │
│    hardware/HardwareClient.ts ┘  execAny() branches on runtime    │
│      ├─ Electron (ipcAvailable)  → window.pos.hardware.exec       │
│      ├─ Browser  (no ipc)        → BrowserHardwareAdapter         │
│      └─ Agent    (no ipc, agent reachable) → AgentClient          │
│    hardware/HardwareExecLog.ts (2s/25-row batched audit)          │
│    hardware/assignmentsRealtime.ts (singleton ref-counted)        │
└───────────────────────────────────────────────────────────────────┘
                  ↓ IPC (Electron only)
┌───────────────── Electron Main Process ──────────────────────────┐
│  CommandRouter (per-role mutex via DeviceManager.withRoleLock)    │
│    ↓                                                              │
│  DeviceManager  ─ health loop (10 s) ─ circuit breaker (3 fails)  │
│    ↓                                                              │
│  Drivers/  EscPosReceipt | EscPosKitchen | EscPosCashDrawer       │
│            EscPosLabel | EplLabel | ZplLabel                      │
│            CustomerDisplay | SerialScale | Mock | TransportDriver │
│    ↓                                                              │
│  Transports/  Usb | Serial | Network(+HMAC) | Bluetooth(BROKEN)   │
│               Cups | WinSpooler                                   │
│    ↓                                                              │
│  CommandQueue (SQLite-backed, retry, status: pending|done|dead)   │
│  SaleSaga     (outbox: print_receipt → open_drawer → display → GL)│
│                key = `${terminalId}:${saleId}:${step}`            │
└───────────────────────────────────────────────────────────────────┘
                  ↓ optional fallback (browser-only)
┌───────────────── Local Agent (HTTP :8043) ───────────────────────┐
│  /status (unauth)  /print  /test  /discover  /usb/print           │
│  Auth: bearer token at ~/.pos-agent-token (NON constant-time cmp) │
│  CORS: Access-Control-Allow-Origin: *                             │
│  Single-tenant                                                    │
└───────────────────────────────────────────────────────────────────┘
                  ↓ Supabase
   public.device_assignments (org_id, business_id, scope_kind+scope_id polymorphic,
                              role, transport, driver, config jsonb, capabilities,
                              enabled, is_default, status, last_seen_at, last_error)
   public.hardware_exec_log  (audit; batched writes)
   public.document_templates, public.pos_kitchen_orders, etc.
```

---

## 4. Data Flow Map — `User → Event → Document → Renderer → Router → Driver → Transport → Device`

### Happy path: POS sale → receipt
```text
Cashier taps "Charge"
  → POSTerminal.tsx commits sale (pos_transactions row)
  → SaleSaga.commit({saleId, payload})  [outbox written, persists across crash]
  → STEP print_receipt
    → PrintClient.printPosReceipt(txnId, opts)
    → useResolvedPrintPolicyWithDevice → {policy, profile, device}
    → generateDocumentEscPosBytes(txn) → Supabase edge fn generate-document
        (auth → membership → entitlement → fetchPOSReceipt → buildDocumentEscPos)
      → Uint8Array
    → hardwareClient.printRawBytes({role:'receipt_printer', bytes})
    → ipcRenderer.invoke('pos:exec', ExecCommand)
    → CommandRouter.exec → withRoleLock('receipt_printer', …)
    → EscPosReceiptDriver.handle → this.send(bytes)
    → TransportDriver.send → switch(transport)
      → UsbTransport.send(vid,pid,bytes) → libusb bulkTransfer
    → device prints; CommandRouter.audit → HardwareExecLog.record (batched)
  → STEP open_drawer / update_display / post_gl (same shape)
```

### Kitchen ticket (Wave 10 new path)
```text
Cashier sends order to kitchen
  → KitchenOrderTicket.tsx Print button (per pos_kitchen_orders row)
  → printClient.printKitchenTicket(txnId, {station: order.printer_category, table, course})
  → generate-document/index.ts (after auth/membership/entitlement, line 1943)
    → short-circuits to escpos/kitchen.ts buildKitchenTicketEscPos(data, opts)
  → hardwareClient.printRawBytes({role:'kitchen_printer', bytes})
  → EscPosKitchenDriver.handle → transport → device
```

### Shadow path (Sales/Purchases/Finance)
```text
User clicks Print on Invoice
  → useDocumentPrint() → PrintPreviewDialog
  → fetch /functions/v1/generate-document?format=pdf
  → PDF blob in iframe → cw.print() (browser dialog)
  ❌ Never touches PrintClient, hardwareClient, device_assignments, or hardware_exec_log
```

---

## 5. Document × Format × Renderer × Driver × Transport

| Document type | Server FETCHER key | Format(s) | Server renderer | Electron driver | Notes |
|---|---|---|---|---|---|
| POS receipt | `pos_receipt` | escpos (coerced if thermal policy), pdf | `_shared/escpos/builder.ts` / `pdfGenerator.ts` | EscPosReceiptDriver | Single canonical path |
| Kitchen ticket | `kitchen_ticket` | escpos only | `_shared/escpos/kitchen.ts` (self-contained) | EscPosKitchenDriver | Wave 10 ✓ |
| Invoice | `invoice` | pdf, escpos | `pdfGenerator.ts` / `PdfBuilder.ts` | Browser/OS or EscPosReceiptDriver | Shadow path active |
| Estimate | `estimate` | pdf, escpos | same | same | Shadow path |
| Proforma | `proforma` | pdf, escpos | same | same | Shadow path |
| Credit note | `credit_note` | pdf, escpos | same | same | Shadow path |
| Purchase order | `purchase_order` | pdf, escpos | same | same | Shadow path |
| **Goods Received Note** | **❌ not registered** | — | — | — | **Calling with `goods_received_note` returns HTTP 400** |
| Delivery note | `delivery_note` | pdf, escpos | same | same | Shadow path |
| Sales order / return | `sales_order` / `sales_return` | pdf, escpos | same | same | Shadow path |
| Payment receipt | `receipt` | pdf, escpos | same | same | Shadow path |
| Inventory label (server) | `inventory_label` | **zpl only** | `_shared/printing/zpl/builder.ts` (admitted stub — 92 lines, fixed 80×50mm template) | ZplLabelDriver / EplLabelDriver / EscPosLabelDriver (dispatched by `assignment.driver`) | Authoritative path |
| Inventory label (client shadow) | — | zpl built **inline in `Products.tsx`** | `Products.tsx:220-238` (hardcoded `^XA…^XZ`) | same | **Shadow** — no template, no audit, no per-tenant customization |
| Shipping label | `shipping_label` | zpl | builder stub | label drivers | TODO per source comment |
| **EPL bytes (server)** | **❌ no server builder** | — | — | EplLabelDriver accepts `print_label` from a `LabelSpec` locally | Driver is **not orphaned** but only the local LabelSpec path is reachable; no end-to-end EPL flow |

### Receipt vs Label vs A4 separation

- **Role enum** (`electron/hardware/types.ts`): `receipt_printer`, `kitchen_printer`, `label_printer`, `cash_drawer`, `scale`, **`scanner`** (duplicate of `barcode_scanner`), `customer_display`, `payment_terminal`, `saga`.
  - **🔴 Inconsistency 1:** Both `scanner` and `barcode_scanner` exist — duplicate concept.
  - **🔴 Inconsistency 2:** `a4_printer` is referenced in `src/services/printing/PrintClient.ts:30` and `src/hooks/hardware/useHardwareProxy.ts:406-409` but is **NOT** in `HARDWARE_ROLES`. A device cannot be assigned to `a4_printer` at the registry level; the references are dead code.
- **Policy coercion** (`_shared/printing/coercePolicy.ts`) correctly forces thermal-paper invoices to escpos and ESC/POS-on-A4 down to 80mm thermal. Receipt/A4 separation is enforced at this layer.
- **Driver guards** — `ZplLabelDriver` rejects payloads lacking `^XA…^XZ`. Misdirected bytes are caught in Electron.
- **🟠 UI gap:** Nothing prevents an operator from binding an 80mm `receipt_printer` profile to the `invoice` document policy; the coercion layer permits thermal invoices.

### `db.device_assignments` actual schema (verified via Supabase)
```
id, organization_id, business_id, scope_kind (text), scope_id (uuid),
role, transport, driver, display_name, config jsonb, capabilities jsonb,
enabled, is_default, status, last_seen_at, last_error,
source_config_id, created_at, updated_at, created_by
```
**Note:** there are NO `branch_id` or `terminal_id` columns. The `mem/features/hardware-platform.md` description "scope = (org, business, branch, terminal)" is encoded via the **polymorphic** `scope_kind`+`scope_id` pair, not direct columns. Useful to know when writing future queries.

---

## 6. Shadow Print-Path Register

| Site | Pattern | Verdict |
|---|---|---|
| `src/services/printing/pdfUtils.ts` (`window.pos.print.pdfBytes` + iframe) | Authorized | Designated implementation behind `PrintClient.print` |
| `src/services/hardware/HardwareClient.ts:572` `printLabelBytes` | Authorized | Canonical label path |
| `src/pages/Products.tsx:220-238` | **🔴 Shadow** | Inline-rendered ZPL bypassing `generate-document` — no template, no policy, no audit |
| `src/pages/Invoices.tsx`, `src/pages/SalesOrders.tsx`, `src/pages/PurchaseOrders.tsx`, `CreditNotes.tsx`, `ProformaInvoices.tsx`, statements | **🔴 Shadow** | `useDocumentPrint` → `PrintPreviewDialog` → browser OS print dialog. Never touches `printClient`/`hardwareClient`/`hardware_exec_log` |
| `src/apps/platform/hardware/HardwareDevices.tsx:233` | Diagnostic-only | OK |
| `window.print(` outside `pdfUtils` | None found | ✅ |
| `new jsPDF(` in `src/` | None found | ✅ |
| Direct `fetch('http://localhost:8043` | None outside `AgentClient`/protocol/diagnostics | ✅ |

### ESLint guard coverage

- `no-direct-pdf-iframe.js` — covers raw PDF blob iframes; tight allow-list.
- `no-raw-hardware-ipc.js` — **2 gaps**:
  1. Entire `src/services/hardware/` is directory-exempt (any new file inherits the exemption).
  2. Only literal forbidden channel strings are blocked; computed channel names or new channels bypass the rule.
- **Missing:** no guard forbidding direct `window.pos.hardware.exec(...)` calls — the existing `hardware-single-chokepoint` test only blocks `window.pos.{usb,serial,hid}`.

---

## 7. Driver & Transport Layer

All 10 drivers comply with the `IDriver`/`BaseDriver` contract. All native modules are lazy-loaded inside transports' `loadBinding()`. All renderer-side drivers that overlap a main-process equivalent are flagged `browserFallback: true` — **with one exception**:

### 🔴 `LineDisplayDriver` registration violates ownership rule
- Registered at `src/services/hardware/drivers/DriverRegistry.ts:178` **without** `{ browserFallback: true }`.
- `LineDisplayDriver.ts:26-33` points its `electronBridge` to `electronBridgeDead` — a stub that always returns `{ success: false, error: 'Electron serial bridge removed in Track H4' }`.
- In Electron mode, the renderer-primary `line_display` driver always fails at connect time and falls through to `navigator.serial`, which the preload does not grant. **The `customer_display` role with `driver: 'line_display'` is silently unreachable.**
- The architecture guard `hardware-driver-duplication.test.ts` does not cover the `line_display` driver type (its `MAIN_COVERED_DRIVER_TYPES` list omits it).

### 🔴 `BluetoothTransport.send` permanently returns failure
- `electron/hardware/transports/BluetoothTransport.ts:58` hardcodes `return { ok: false, error: 'bluetooth GATT write requires vendor adapter' }`.
- `BluetoothPairingManager.healthCheck()` may return `ok: true` (device paired, BLE reachable) while every write fails. Operator sees a green device card; nothing prints.
- No `// TODO`, no ADR reference, no UI warning.

### 🟠 `SerialTransport.getOrOpen()` has no open timeout
- `electron/hardware/transports/SerialTransport.ts:139-151` waits indefinitely for `'open'`/`'error'` events.
- A stuck USB-serial adapter (CDC ACM stuck in enumeration) hangs the CommandQueue worker for that device.

### 🟠 No retry on any transport
- All six transports return `{ ok: false }` on first failure. No backoff. `LIBUSB_ERROR_IO` from a momentarily full printer buffer drops the job silently. No `CommandQueue`-level retry visible above and beyond the `maxAttempts` budget.

### 🟡 Other driver/transport observations
- **SerialScaleDriver** calls `SerialTransport.subscribe()` and `.send()` directly rather than `this.send()` (justified by bidirectional streaming, but a leaky abstraction).
- **MockDriver** always returns `ok: true` from healthCheck — no runtime guard preventing it from being bound to a real role in production.
- **EscPosCashDrawerDriver** hardcodes pulse timings `t1=25, t2=250 ms` — non-standard solenoids (e.g. some Posiflex) require code changes.
- **EscPosLabelDriver** is the default fallback when `assignment.driver` is unknown (`drivers/index.ts:64`) — sending ESC/POS to a real Zebra produces garbage.
- **WinSpoolerTransport** recompiles the inline `Add-Type` PowerShell block on every print — high first-print latency per session.
- **`hardcoded VID/PID tables`** in `escpos-commands.ts:61-88` — used only by renderer-side scoring; main process is capability-driven. Unlisted brands silently score 0 in plug-and-play wizard.

---

## 8. Discovery → Classification → Registration

### Flow
1. `pos:hardware:discover` IPC → `discoverAllDevices()` (USB + Serial + Network in parallel).
2. `classifyUsb(d)` + network `classification` aggregated into ranked `candidates[]`.
3. `DeviceWizard.tsx` shows the list → operator picks → form pre-filled → operator may edit → `upsert.mutateAsync({scope_kind: "tenant", ...})`.
4. Realtime fires → `ElectronAssignmentHydrator` → `window.pos.devices.upsert` → SQLite cache → `DeviceManager.bootstrap()` re-registers handlers.

### 🔴 Gaps
- **Serial candidates are never classified** — `electron/hardware/discovery/index.ts:32-36` only invokes `classifyUsb` and network classification. Serial-attached scales and receipt printers appear in the raw list but produce zero wizard suggestions.
- **`classify.ts:81` maps name-hint `display`/`vfd`/`customer` → `receipt_printer` role.** A VFD customer display plugged in is suggested as a receipt printer.
- **Wizard saves `scope_kind: "tenant"` only** (`DeviceWizard.tsx:229`). Register/station-scoped bindings can't be created through the UI; operators must use raw JSON.
- **"Test reachability" tests the wrong device** — `handleTest` calls `hardwareClient.devices.testRoleConnection(form.role)` against the *already-registered* handler for that role, not the newly selected candidate (admitted in the inline comment at line 198-203).
- **No inline bootstrap after save** — wizard shows "Restart the terminal to activate" toast. Realtime hydrator does trigger reload, but operator UX implies a restart is required.

### Plug-and-play readiness matrix

| Role | Discovery | Classification | Driver pre-fill | Auto-bind | Zero-config first print |
|---|---|---|---|---|---|
| receipt_printer | 🟢 USB | 🟢 Major brands | 🟢 | 🔴 Manual save | 🔴 |
| kitchen_printer | 🟡 USB only | 🟡 Name-hint only | 🟡 | 🔴 | 🔴 |
| label_printer | 🟢 Zebra/SATO VIDs | 🟢 ZPL/EPL | 🟢 | 🔴 | 🔴 |
| cash_drawer | 🔴 No VIDs | 🟡 Name-hint | 🟡 | 🔴 | 🔴 |
| scale | 🟡 Mettler only | 🟡 One vendor | 🟡 | 🔴 | 🔴 |
| barcode_scanner | 🟢 Major vendors | 🟢 | 🟢 | 🔴 | 🔴 |
| customer_display | 🔴 Mis-classified as receipt | 🔴 | 🔴 | 🔴 | 🔴 |
| payment_terminal | 🔴 Not discoverable | 🔴 | 🔴 | 🔴 | 🔴 |

**Overall:** Zero-config first print is **not achievable** for any role. The product philosophy ("plug in, go") is not yet realized.

---

## 9. Local Agent

### Strengths
- HTTP API matches `protocol.ts` exactly.
- Network transport in Electron has HMAC-signed agent path with constant-time verify (`NetworkTransport.ts:109-132`).
- `/status` permits unauthenticated health-checks (sensible for autodiscovery).

### 🔴 Gaps
- **Non-constant-time auth comparison.** `agent/src/auth.ts:71` — `parts[1] === token`. Timing-attack vulnerable. Localhost-only mitigates but is technically wrong; use `crypto.timingSafeEqual`.
- **Wildcard CORS.** `Access-Control-Allow-Origin: *` (`agent/src/server.ts:16`). Any page rendered in any browser on the host can hit the agent's print endpoint and exfiltrate the USB device list.
- **Single-tenant.** No org or workspace concept; one token for whoever installed the agent.
- **`runtimeCapability()` agent branch** in `HardwareClient.ts` does NOT call `/healthz` (the doc/mem comment is wrong — agent only exposes `/status`). Real code calls `agentClient.probe()` which hits `/status`.

---

## 10. Runtime path duplication

`HardwareClient.execAny()` correctly picks exactly **one** branch (Electron IPC, browser adapter, agent) per call and records the choice in a ring buffer (`getRecentRuntimeReasons()`). No silent dual dispatch. ✅

But:
- An `electron-fallback-unexpected` (Electron mode but no IPC) logs only `console.warn` — no toast, no diagnostics flag. Operators won't notice a stale preload.
- `hardware-single-chokepoint` arch test does **not** block direct `window.pos.hardware.exec(...)` access — only `window.pos.{usb,serial,hid}`. A developer can route around `hardwareClient`, losing audit, runtime-reason logging, and exec context, with no test failure.

---

## 11. Reliability & Observability

### Strengths
- `CommandQueue` is SQLite-backed; survives Electron restart.
- `SaleSaga.replayUnfinished()` is called at startup (`electron/main.ts:132-136`).
- Per-role mutex prevents probe-mid-print collisions.
- HardwareExecLog batched writes are tight.

### 🔴 Critical gaps
1. **Dead-letter queue invisible to operator.** `CommandQueue.ts:116-117` writes `status: 'dead'` to SQLite on retry exhaustion. `HardwareDiagnostics.tsx` does **not** query or render `dead` rows. Operators discover missed prints only when a customer complains.
2. **Terminal-ID collision risk.** `ElectronHydratorMount.tsx:23` reads `localStorage 'pos:activeTerminalId'`. If the value is absent (new install, cleared storage, incognito), `terminalId` defaults to `"default"` and `SaleSaga.keyFor` produces `"default:${saleId}:${step}"`. Two terminals without the key set will collide on idempotency, silently deduplicating the second terminal's prints as already done.
3. **Saga payload loss is silent.** `SaleSaga.ts:164` — if `PayloadStore.get(saleId)` returns null on replay, the row is skipped with a comment "operator must intervene" — no event emitted, no UI alert.
4. **No watchdog for agent reconnect.** `runtimeCapability()` caches 5s; nothing re-probes after a transient agent outage until the next call.

### 🟠 Medium
5. **Duplicate realtime channel in Electron.** `assignmentsRealtime.ts` and `ElectronAssignmentHydrator.ts:166-173` open **two** parallel realtime channels on the same `device_assignments` table for the same org. Doubles WebSocket load.
6. **Health-loop ticks race with reload.** `DeviceManager.tick()` probes in parallel; in-flight probe results can be written to stale `DeviceStatus` after `stop()`.

---

## 12. Security gaps in Edge Functions

### 🔴 ZPL branch bypasses tenant gating
`generate-document/index.ts:1642` — the `format=zpl` early-exit fires **before** the org-membership check at line ~1912 and the subscription entitlement check at line 1931. Any authenticated user (any org) can render ZPL labels for any `inventory_label` documentId they can guess (UUID — high entropy but still a tenancy boundary). The kitchen-ticket short-circuit at line 1943 is correctly placed after gating; the ZPL branch should be moved to the same position.

### 🟡 `pos_receipt_preview` early-exit also pre-gating (line 1669)

---

## 13. Risk Register (severity × likelihood)

| # | Risk | Severity | Likelihood | Where |
|---|---|---|---|---|
| 1 | Sales/Purchases/Finance prints bypass `PrintClient` (shadow path) | 🔴 | Certain | `useDocumentPrint`, `PrintPreviewDialog` |
| 2 | Dead-letter queue invisible to operator | 🔴 | High | `HardwareDiagnostics.tsx` |
| 3 | `BluetoothTransport.send` permanently fails | 🔴 | Certain on any bluetooth assignment | `BluetoothTransport.ts:58` |
| 4 | `LineDisplayDriver` broken in Electron | 🔴 | Certain when selected | `DriverRegistry.ts:178`, `LineDisplayDriver.ts:26-33` |
| 5 | Terminal-ID collision when localStorage missing | 🔴 | Medium | `SaleSaga.ts:90`, `ElectronHydratorMount.tsx:23` |
| 6 | ZPL renderer bypasses org/entitlement gating | 🔴 | Certain | `generate-document/index.ts:1642` |
| 7 | Agent auth string-equality + wildcard CORS | 🔴 | Low (localhost) | `agent/src/auth.ts:71`, `agent/src/server.ts:16` |
| 8 | GRN document type not registered in `FETCHER_MAP` | 🟠 | Certain when triggered | `generate-document/index.ts` |
| 9 | `SerialTransport.getOrOpen` no open timeout | 🟠 | Medium | `SerialTransport.ts:139-151` |
| 10 | No retry on any transport | 🟠 | High at peak | All transports |
| 11 | Serial candidates never classified | 🟠 | Certain for serial hardware | `discovery/index.ts:32-36` |
| 12 | Customer display mis-classified as receipt printer | 🟠 | Certain when name-hint hit | `classify.ts:81` |
| 13 | Two terminals, one physical printer — no inter-process transport mutex | 🟠 | Medium in multi-seat | `assignments/store.ts:146` |
| 14 | Wizard saves `scope_kind: "tenant"` only | 🟡 | Certain | `DeviceWizard.tsx:229` |
| 15 | Duplicate realtime channel in Electron | 🟡 | Certain | `ElectronAssignmentHydrator.ts:166` |
| 16 | `Products.tsx` ZPL hardcoded inline (no template, no audit) | 🟡 | Certain | `Products.tsx:220-238` |
| 17 | `a4_printer` referenced but not in HARDWARE_ROLES | 🟡 | Latent | `PrintClient.ts:30`, `useHardwareProxy.ts:409` |
| 18 | Duplicate role enum: `scanner` and `barcode_scanner` | 🟡 | Latent | `electron/hardware/types.ts:23-24` |
| 19 | ZPL builder is admitted stub (fixed 80×50mm) | 🟡 | Certain at custom-size demand | `zpl/builder.ts` |
| 20 | EPL server-side renderer absent | 🟡 | Certain for EPL printers | `_shared/printing/` |
| 21 | `MockDriver` reachable in production | 🟡 | Low | `MockDriver.ts:32` |
| 22 | `no-raw-hardware-ipc` allow-list: directory-wide exemption + only-literal-channel match | 🟡 | Latent | `eslint-rules/no-raw-hardware-ipc.js:82` |
| 23 | `hardware-single-chokepoint` test doesn't cover `window.pos.hardware.exec` | 🟡 | Latent | `hardware-single-chokepoint.test.ts` |
| 24 | `HARDWARE_CAPABILITY_MATRIX.md` stale (label_printer listed as EscPosReceiptDriver) | 🟢 | Documentation only | docs file |
| 25 | Stale `pos_hardware_configs` mention in DeviceManager error log | 🟢 | Cosmetic | `DeviceManager.ts:139` |
| 26 | Scale driver completely unwired (no app consumer) | 🟢 | Latent feature gap | — |

---

## 14. What Wave 10 missed / under-emphasized

The previous agent's audit was technically honest about its own scope but **did not surface**:

1. The **Sales/Purchases/Finance shadow print path** — the single biggest deviation from the documented architecture.
2. **GRN absent from `FETCHER_MAP`**.
3. **ZPL renderer pre-gating bypass** in `generate-document`.
4. **Inventory `Products.tsx` inline ZPL** — bypasses the server renderer entirely.
5. **Bluetooth transport stub** failing silently.
6. **`LineDisplayDriver` broken Electron path** + arch-test blind spot.
7. **Terminal-ID collision** when `localStorage` is missing.
8. **Agent auth + CORS posture**.
9. **Dead-letter queue not surfaced** in HardwareDiagnostics.
10. **Serial candidates never classified**.
11. **`customer_display` misclassified** by name-hint.
12. **Duplicate `scanner`/`barcode_scanner`** in role enum and dead **`a4_printer`** references.
13. **Duplicate realtime channel** in Electron.
14. **`no-raw-hardware-ipc` gaps** and **`hardware-single-chokepoint` not covering `window.pos.hardware.exec`**.

Wave 10 verified its own claims accurately, but did not zoom out to non-POS apps or to the edge-function security boundary.

---

## 15. Recommended Target Architecture

1. **Cross-app print client.** Every document print across every app routes through `printClient.print({ documentType, documentId, intent })`. Retire `useDocumentPrint`/`PrintPreviewDialog` as the print actuator; keep it only as a preview surface. Add an arch-test forbidding `cw.print()` outside `pdfUtils`.
2. **Operator-visible queue UI.** `HardwareDiagnostics.tsx` (or a sibling page) renders `hw_command_queue` rows where `status='dead'` with replay/discard actions.
3. **Server-driven label engine.** Replace `Products.tsx` inline ZPL with a `label_templates` table mirroring `document_templates`, rendered by `generate-document` (format=zpl|epl).
4. **Hardware role canonicalization.** Drop duplicate `scanner`; either add `a4_printer` to `HARDWARE_ROLES` or remove dead references; collapse `barcode_scanner` to single canonical name.
5. **Tenant-gating fix.** Move ZPL and `pos_receipt_preview` early-exits in `generate-document` to *after* org-membership + entitlement checks (mirror the kitchen-ticket placement).
6. **Single chokepoint extension.** `hardware-single-chokepoint.test.ts` allow-lists must include `window.pos.hardware.exec` accessors; `no-raw-hardware-ipc.js` directory exemption replaced with file-scoped allow-list.
7. **Terminal-ID required-invariant.** `ElectronHydratorMount` refuses to mount until a terminal id is set; SaleSaga refuses to enqueue without `terminalId !== null`.
8. **Bluetooth transport.** Either remove the role-driver option from the UI or implement Web Bluetooth GATT write with vendor adapters (Star, Zebra, Brother SDKs).
9. **Discovery classification parity.** Add `classifySerial()` mirroring `classifyUsb`; fix `classify.ts:81` to not map "display" → `receipt_printer`.
10. **Agent hardening.** `crypto.timingSafeEqual` + restrict CORS to known POS origins + add multi-tenant token rotation.
11. **Transport retry policy.** Add 3-attempt exponential backoff in `CommandQueue` for transient transport errors (USB IO, network ETIMEDOUT).
12. **Wizard scope picker.** `DeviceWizard` exposes `scope_kind` selector (tenant / business / register / station).
13. **GRN renderer.** Register `goods_received_note` in `FETCHER_MAP` and add a `pdfGenerator` template.

---

## 16. Prioritized Remediation Roadmap

### P0 — Production-blocking, ship in next wave
- R1: Move Sales/Purchases/Finance prints behind `PrintClient` (cross-app routing).
- R2: Dead-letter queue UI in `HardwareDiagnostics.tsx`.
- R6: ZPL/`pos_receipt_preview` tenant-gating fix in `generate-document`.
- R5: Terminal-ID required invariant; fail loudly when missing.
- R3 (or removal): Bluetooth transport — either implement or remove from UI options.
- R4: Fix `LineDisplayDriver` registration (mark `browserFallback: true` and route through main).

### P1 — High-impact, next 1-2 waves
- R7: Agent auth (timing-safe compare, scoped CORS).
- R8: Register GRN in `FETCHER_MAP`.
- R9: `SerialTransport.getOrOpen` timeout + transport-level retry policy.
- R10: Replace `Products.tsx` inline ZPL with server `label_templates`.
- R11: `classifySerial()` + fix `classify.ts:81` mapping bug.

### P2 — Architectural cleanup
- R12: Role-enum canonicalization (drop `scanner`, decide on `a4_printer`).
- R13: Tighten arch tests (`hardware-single-chokepoint` covers `window.pos.hardware.exec`; `no-raw-hardware-ipc` file-scoped allow-list).
- R14: Wizard `scope_kind` selector.
- R15: Collapse duplicate realtime channel in Electron mode.
- R16: Wire scale driver into Inventory / Receiving workflows.

### P3 — Documentation & cosmetic
- Update `HARDWARE_CAPABILITY_MATRIX.md` to reflect ZPL/EPL/ESC-POS label driver dispatch.
- Update `mem/features/hardware-platform.md` agent endpoint reference (`/status`, not `/healthz`).
- Remove stale `pos_hardware_configs` mention in `DeviceManager.ts:139`.
- Add ADR for "single cross-app print router" formalizing R1.

---

## 17. Closing notes

- Wave 10's specific implementation work is **honest and verified**; the previous agent did not lie about anything material.
- The architecture is **POS-centric**, not yet cross-app. The biggest single lift to realize the product philosophy is to retire `useDocumentPrint`/`PrintPreviewDialog` as the print actuator and route every app through `printClient` — that single change closes 4 of the 7 P0/P1 risks (shadow paths, audit invisibility, lack of device awareness in non-POS apps, and ZPL label flow consolidation).
- Plug-and-play remains 🔴 across the board: no role today supports zero-config first print. Closing the wizard's "manual save + reload" gap is a worthwhile separate wave.

**No code was modified by this audit.** The remediation roadmap items are scoped for follow-up build-mode sessions, prioritized item-by-item.
