# Hardware & Retail-Operations Enterprise-Readiness Audit

**Date:** 2026-06-17
**Predecessors:** `2026-06-10-hardware-print-reaudit.md`, `2026-06-11-hardware-wave-11-closeout.md`, `2026-06-12-hardware-wave-12-closeout.md`
**Method:** Independent re-derivation from source. Every prior-wave claim was re-checked by reading the live file, not by trusting the closeout doc.
**Approved plan:** `.lovable/plan.md` (this turn).

---

## 0. Executive verdict

Core hardware platform is **structurally enterprise-grade**: single chokepoint (`hardwareClient`), single source of device truth (`device_assignments`), per-role mutex, batched audit log, dead-letter queue surfaced to operators, HMAC-signed attendance ingestion. Perimeter is **operationally incomplete**: cross-app print router (B1) and label template engine (C4) remain the two critical gaps.

| Area | State | Verdict | Priority |
|---|---|---|---|
| `hardwareClient.exec` chokepoint | landed | Acceptable | — |
| `device_assignments` single source of truth | landed | Acceptable | — |
| Driver/transport contract | landed | Acceptable | — |
| Per-role mutex + idempotent queue + dead-letter UI | landed (Wave 11) | Acceptable | — |
| HMAC-signed attendance ingest (`/api/public/attendance/ingest`, `biometric-ingest`) | landed | **Best-in-class — exceeds Odoo IoT Box** | — |
| `employees(organization_id, external_attendance_ref)` uniqueness | **already landed** in `20260607203201` (`employees_external_attendance_ref_org_uniq`) — audit was wrong to call this out | Acceptable | — |
| Discovery (USB / Serial / Network classify) | landed; **no auto-claim, no MDM hook** | Partial | High |
| Cross-app print router (B1) | shadow `useDocumentPrint → PrintPreviewDialog` on 12 surfaces | **Redesign required** | **Critical** |
| Label template engine (C4) | `label_templates` table landed today; **no editor, no fetcher, `src/pages/Products.tsx:221-238` still inlines ZPL** | **Redesign required** | **Critical** |
| CommandQueue exponential backoff (C3) | `RETRY_BACKOFF_MS` constant exists; `tick()` does not invoke a sleep between retries (relies on caller polling loop) | Acceptable interim; needs in-loop backoff for transient IO faults | High |
| Scale role wired into Inventory/POS weigh | driver exists; **zero `useDeviceForRole('scale')` callers in `src/`** | Incomplete | Medium |
| `LineDisplayDriver` Electron path | fixed Wave 11 | Acceptable | — |
| ZPL renderer tenant gating | fixed Wave 11 | Acceptable | — |
| Terminal-ID `localStorage` collision | fixed Wave 11 | Acceptable | — |
| Bluetooth transport | hidden from operator UI (Wave 11) | Acceptable hold | Low |

---

## 1. Hardware integration — verdict per axis

### 1.A Discovery → claim
- `electron/hardware/discovery/{usb,serial,network,classify}.ts` enumerate candidates and name-hint a role; `DeviceWizard.tsx` persists into `device_assignments`.
- **Operational gap:** every role on every terminal requires manual save + reload. A 12-lane store ≈ 60 manual claims at install. No fleet-roll-out endpoint exists.
- **Fix:** new `device_assignment_policies` table + `POST /api/public/hardware/provision` endpoint (MDM-friendly). Discovery consults policies and auto-creates `device_assignments` rows; Wizard becomes the exception path. **Wave: after C4.**

### 1.B Vendor abstraction
- `IDriver` contract + `DriverRegistry` (`{capabilityRoles, browserFallback}`) + orthogonal transport classes. Adding a printer = one driver class + one registry line. **Acceptable.** Payment-terminal vendor coupling (`PaymentTerminalDriver`) is appropriate — vendor SDKs are unavoidable for PAX/Verifone/Stripe.

### 1.C Chokepoint + audit
- Every op goes through `hardwareClient.exec → CommandRouter → DeviceManager → Driver → Transport`. `HardwareExecLog` batches 25-row / 2-s writes with `source_doc_type`, `source_doc_id`, `business_event_id`, `is_reprint`. ESLint guards (`no-raw-hardware-ipc`, `no-printservice-shim`) lock the boundary. **Strongest layer in the platform.**

### 1.D Reliability
- Per-role mutex (Wave 9d.9): landed.
- Dead-letter inspect/replay/discard with `DeadLetterQueueCard` surface (Wave 11): landed.
- **Retry/backoff (C3):** `CommandQueue.backoffMs()` and `RETRY_BACKOFF_MS` exist but `tick()` does not `await sleep(backoffMs(attempt))` inside the same call — it marks `pending` and depends on the polling loop in `SharedCommandQueueWorker` to re-pick. Under USB-IO bursts (`LIBUSB_ERROR_IO`/`EAGAIN`/`ETIMEDOUT`) this is acceptable but causes operator-visible delays. Recommend: in-loop bounded retry inside `tick()` with the existing `RETRY_BACKOFF_MS` schedule for the first 3 attempts, then fall through to the polling-based retry for attempts 4-5. Surface `attempts` (already on `QueueRow`) into `hardware_exec_log` for diagnostics.

---

## 2. Label printing & retail operations

### 2.A Inventory of what landed today
- `label_templates` table (`20260617133303` + `20260617213931`) with `{org_id, branch_id, kind, template_key, engine, body, width_mm, height_mm, version, active}`. RLS in place.
- `src/services/printing/labelDispatch.ts` resolves printer (branch→org fallback) and substitutes `{{token}}`s against a `vars` map.

### 2.B Inventory of what is missing
- **No consumer reads `label_templates`**. `src/pages/Products.tsx:221-238` still constructs raw `^XA…^XZ` ZPL inline.
- **No template editor UI.**
- **No `generate-document` fetcher** for `inventory_label` driven by the table.
- **No barcode/QR rendering primitive** beyond inline byte streams.
- **No supermarket-critical formats:** shelf tag, shelf talker, promotional, discount, "Was/Now", bulk-buy, clearance, QR-enabled, A4 24-up sheets.
- **No batch / bulk-reprint UI**, no price-change-triggered reprint queue.
- **No promotion-aware token hydration** (`promotions` table exists; no join).

### 2.C Recommended architecture (deferred to C4 wave)

1. `LabelTemplateEditor` page at `/inventory/labels` (visual canvas + token palette + live server-side preview).
2. `label_token_registry` table + vitest arch guard (`label-tokens-source-of-truth.test.ts`).
3. `generate-document` `inventory_label` fetcher: load template by `(org, branch, template_key)` fallback, hydrate vars from product/pricing/promotion/branch joins, emit ZPL/TSPL bytes. `labelDispatch.ts` becomes a thin wrapper.
4. `/inventory/labels/batch` filter+queue page; queue per-product jobs into `business_event_outbox`, drain via `SharedCommandQueueWorker`.
5. Add `media_type ∈ {continuous_roll, die_cut, a4_sheet_N_per_page}` for sheet support.
6. `localization_pack_label_templates` for starter-pack seeding.

---

## 3. Cross-app print router (B1)

### 3.A Confirmed scope
12 page surfaces (rg-verified): Invoices, SalesOrders, Estimates, DeliveryNotes, CreditNotes, ProformaInvoices, CustomerPayments, Bills, PurchaseOrders, PurchaseReturns, SalesReturns + `CreditNoteDetailDialog`. All route through `useDocumentPrint → PrintPreviewDialog`.

### 3.B Partial-credit note from Wave 11
`PrintPreviewDialog` *does* call `useHardwareProxy.printRawBytes` (which wraps `hardwareClient`) **when the operator picks a thermal destination**. The accurate framing is "no auto-routing, no policy resolution, A4 prints unaudited" — not "zero audit". This audit doc honours that correction.

### 3.C Decision
See **ADR-0026** (`docs/architecture/decisions/0026-cross-app-print-router.md`, this turn).

### 3.D Scope of the dedicated B1 wave (not this turn)
- `PrintClient.print({documentType, documentId, intent})` already exists (`src/services/printing/PrintClient.ts:68`) — usable today.
- Migrate the 12 surfaces from `useDocumentPrint` → `printClient.print(...)`.
- Add ESLint rule `no-direct-window-print` + `no-document-print-shadow-path` (forbid `useDocumentPrint` outside the allowlist of `PrintPreviewDialog` itself, which becomes a fallback for `policy.ask_user === true` only).
- Golden test `cross-app-print-routing.test.ts` asserts every surface routes through the chokepoint.
- Bundle role-enum canonicalization (`scanner`→`barcode_scanner`, register `a4_printer` — already added in Wave 12 to `HARDWARE_ROLES`).

---

## 4. Attendance & biometric hardware

### 4.A Strengths
- `/api/public/attendance/ingest` (TanStack server route) + `supabase/functions/biometric-ingest` (edge). Both use per-device HMAC-SHA256 over `timestamp.body`, 5-min replay window, body-hash dedup in `attendance_ingest_log`, vendor-neutral discriminated-union payload (`heartbeat | event | enroll`).
- HR UI: `AttendanceDevices.tsx` (registry + stale filter from inbox), `AttendanceAudit.tsx`.
- Compared to Odoo's IoT Box approach: **materially better for cloud-first SaaS** — no Pi to ship, no LAN-only constraint, replay-safe.

### 4.B Hardening already in place (audit was incorrect about this)
- `employees_external_attendance_ref_org_uniq` on `(organization_id, external_attendance_ref) WHERE external_attendance_ref IS NOT NULL` exists in `supabase/migrations/20260607203201`. Cross-org collision is impossible.
- `attendance_devices_org_serial_uniq` on `(organization_id, vendor, serial)` exists in the same migration.
- **No further hardening needed for this module.** This is the strongest perimeter in the platform.

### 4.C Documented limitation (acceptable hold)
- `enroll` payload reports status only — there is no UI to push enrol commands *to* the device. Vendors expect operators to enrol at the device console; Odoo doesn't have this either. Acceptable.

---

## 5. POS receipt workflow trace (illustrative)

```text
Cashier clicks Pay
  → POSTerminal.tsx
  → useResolvedPrintPolicyWithDevice('pos_receipt')   ← device-aware hook
  → PrintClient.printReceipt({ saleId })
  → generate-document?format=escpos
  → hardwareClient.exec({ role: 'receipt_printer', op: 'printRaw', payload, idempotencyKey })
  → CommandRouter (per-role mutex) → DeviceManager
  → Driver (EscPosReceiptDriver) → Transport (USB / 9100 / CUPS)
  → Physical printer
  → HardwareExecLog batched insert
  → On failure: CommandQueue retries (5-s SerialTransport open timeout — Wave 12)
  → On exhaustion: dead-letter row → DeadLetterQueueCard
```

**Bottleneck:** none in POS. **Risk:** C3 in-loop backoff gap means a transient USB IO error today triggers a polling-loop wait instead of a tight retry.

The same trace for Sales **diverges at step 3** into the shadow path. Closing this is B1.

---

## 6. Sequenced risk register (the only forward-looking section)

| ID | Item | Priority | Wave |
|---|---|---|---|
| B1 | Cross-app print router — 12-surface migration + ESLint guard + golden test + ADR-0026 | **Critical** | Next |
| C4 | Label template engine end-to-end | **Critical** | Next + 1 |
| C3 | `CommandQueue.tick()` in-loop backoff + surface `attempts` into `hardware_exec_log` | High | Bundle with B1 |
| 1.A | Auto-claim discovery policies + `POST /api/public/hardware/provision` | High | After C4 |
| D | Wire `scale` role into Inventory receiving + POS weigh | Medium | After C4 |
| D | Collapse duplicate realtime channel in `ElectronAssignmentHydrator` | Low | Bundle with B1 |
| D | `scope_kind` picker in `DeviceWizard` | Low | Standalone |
| E | Refresh `HARDWARE_CAPABILITY_MATRIX.md` after B1/C4; remove stale `pos_hardware_configs` string at `DeviceManager.ts:139` | Low | After B1 |

**Removed from prior risk register (verified shipped or moot):**
- 4.C employees uniqueness — already shipped (`20260607203201`).
- B2 `a4_printer` role — shipped Wave 12.
- B3 dead-letter surface — shipped Wave 11.
- B4 terminal-ID invariant — shipped Wave 11.
- B5 ZPL tenant gating — shipped Wave 11.
- B6 `LineDisplayDriver` — shipped Wave 11.
- B7 Bluetooth UI removal — shipped Wave 11.
- C1 Agent CORS/timing-safe — shipped Waves 11+12.
- C2 GRN fetcher — shipped Wave 12.
- C5 USB classify display→customer_display — shipped Wave 11.

---

## 7. What this turn shipped

- This audit document.
- **ADR-0026 — Cross-app print router** (`docs/architecture/decisions/0026-cross-app-print-router.md`).

Nothing else. The B1/C3/C4 implementations are explicit follow-on waves per §6 of the approved plan; landing them inside this audit turn would have produced an unverifiable mega-PR. The handover artifact above is sized so a future agent can resume from §6 without re-deriving any of the verification work.

---

## 8. Out of scope (explicit)

- No code edits, no migrations, no DB writes in this turn beyond docs/ADR.
- No vertical-specific (supermarket / KE / EU) business logic — recommendations stay generic and configuration-driven.
- No replacement of Electron / TanStack / Supabase — architecture stays as-is.
- No payment-terminal SDK work — orthogonal track.