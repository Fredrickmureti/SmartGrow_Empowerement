# Hardware Wave 11 — Re-audit Verification + P0/P1 Remediation Closeout

**Date:** 2026-06-11
**Predecessor:** `docs/audit/2026-06-10-hardware-print-reaudit.md`
**Method:** Independent line-level re-verification of every Wave-10 + Wave-10b claim. Implemented a focused subset of the P0/P1 roadmap.

---

## 1. Re-verification of prior audit claims

Each item below was confirmed by reading the live file (no edits).

| Prior claim | Verdict | Evidence |
|---|---|---|
| 12 pages route through shadow `useDocumentPrint`/`PrintPreviewDialog` | ✅ Confirmed | `rg -l useDocumentPrint src` → Invoices, SalesOrders, Estimates, DeliveryNotes, CreditNotes, ProformaInvoices, CustomerPayments, Bills, PurchaseOrders, PurchaseReturns, SalesReturns + finance dialogs |
| `BluetoothTransport.send` hardcodes failure | ✅ Confirmed | `electron/hardware/transports/BluetoothTransport.ts:58` |
| `LineDisplayDriver` registered without `browserFallback: true` | ✅ Confirmed | `DriverRegistry.ts:178` |
| ZPL early-exit pre-gating | ✅ Confirmed | `generate-document/index.ts:1642` (pre-edit) |
| `ElectronHydratorMount` reads `localStorage` → silent `"default"` | ✅ Confirmed | `ElectronHydratorMount.tsx:23` (pre-edit) |
| `SaleSaga.terminalId = 'default'` fallback | ✅ Confirmed | `SaleSaga.ts:75, 90` (pre-edit) |
| GRN not in `FETCHER_MAP` | ✅ Confirmed | `rg goods_received_note supabase/functions/generate-document` → 0 hits |
| `Products.tsx` inline ZPL | ✅ Confirmed | lines 215-238 |
| Dead-letter queue invisible | ✅ Confirmed | 0 references to `'dead'` in `HardwareDiagnostics.tsx` (pre-edit) |
| `agent/src/auth.ts:71` non-constant-time compare | ✅ Confirmed | `parts[1] === token` (pre-edit) |
| `classify.ts:81` mis-maps display→receipt | ✅ Confirmed (pre-edit) |
| `Bluetooth` exposed in wizard transport dropdown | ✅ Confirmed | `DeviceWizard.tsx:92` |

**Partial correction:** The audit framed the Sales/Purchases/Finance path as "never reaches `hardwareClient`". In fact `PrintPreviewDialog` does call `useHardwareProxy.printRawBytes` (which wraps `hardwareClient`) when the operator picks a thermal destination. The accurate statement is **it bypasses `PrintClient` policy resolution and never auto-routes** — operators must manually pick the destination per print. The audit logging exists; the routing intelligence doesn't.

---

## 2. What was implemented this wave

### ✅ Implemented

| Roadmap | Change | File(s) |
|---|---|---|
| **R6** ZPL tenant-gating fix | Moved `format === "zpl"` branch from line 1642 (pre-auth) to right before the kitchen_ticket short-circuit (post org-membership + entitlement). Cross-org `format=zpl` now 403s. | `supabase/functions/generate-document/index.ts` |
| **R4** `LineDisplayDriver` registration | Added `{ browserFallback: true }` so Electron mode routes to main-process `CustomerDisplayDriver` instead of `electronBridgeDead`. | `src/services/hardware/drivers/DriverRegistry.ts` |
| **R3** Bluetooth removed from operator UI | Dropped `bluetooth` from `TRANSPORT_OPTIONS` in `DeviceWizard`. Driver class retained for future vendor-adapter work. | `src/apps/platform/hardware/DeviceWizard.tsx` |
| **R5** Terminal-ID required invariant | `SaleSaga.terminalId` is now `null` by default; `keyFor()` throws loudly if not bound. `ElectronHydratorMount` auto-generates a stable per-install UUID on first boot instead of falling back to `"default"`. | `electron/hardware/SaleSaga.ts`, `src/components/hardware/ElectronHydratorMount.tsx` |
| **R2** Dead-letter queue surface (full stack) | New `CommandQueue.listDead/replayDead/discardDead` methods. New IPC: `pos:queue:list-dead`/`replay-dead`/`discard-dead`. New `window.pos.queue` preload bridge. New `DeadLetterQueueCard` component rendered at the top of `HardwareDiagnostics`. | `electron/hardware/CommandQueue.ts`, `electron/main.ts`, `electron/preload.ts`, `src/components/hardware/DeadLetterQueueCard.tsx`, `src/apps/platform/hardware/HardwareDiagnostics.tsx` |
| **R7** Agent auth timing-safe compare | Replaced `parts[1] === token` with a `crypto.timingSafeEqual` wrapper that handles length mismatch without leaking via timing. | `agent/src/auth.ts` |
| **R11** Customer-display classification | `classify.ts` name-hint for `display|vfd|customer` now maps to `customer_display` + `line_display` driver (was incorrectly mapping to `receipt_printer`). | `electron/hardware/discovery/classify.ts` |
| Preload bump | `preloadBuild` → `11-2026-06-11`; `preloadFeatures` adds `queue`. | `electron/preload.ts` |

### 🟡 Deferred (still on the roadmap, intentionally not in this wave)

| Roadmap | Reason for deferral | Recommendation |
|---|---|---|
| **R1** Cross-app print router behind `PrintClient` | Largest single change in the roadmap; touches 12 page files plus the print-policy resolver. Needs its own ADR (proposed `0026-cross-app-print-router.md`) and a dedicated PR with golden tests. | Next wave (Wave 12). |
| **R8** GRN in `FETCHER_MAP` | Needs `fetchGoodsReceivedNote` + a `pdfGenerator` template; small but adjacent to R1 since the GRN print button should land on the new cross-app router. | Bundle with R1. |
| **R9** Transport retry / timeout policy | Touches all six transports and the CommandQueue dispatch loop; deserves its own wave with reliability-focused tests. | Next wave. |
| **R10** Server-driven `label_templates` engine | New table + migration + edge fn fetcher + UI; sized at a full wave on its own. | Wave 12. |
| **R12** Role-enum canonicalization (`scanner`, `a4_printer`) | Cosmetic but ripples through 10+ files and 2 ESLint rules. Best done alongside R1 since A4 routing needs the enum anyway. | Bundle with R1. |
| **R13** Tighten `hardware-single-chokepoint` + `no-raw-hardware-ipc` allow-lists | Low-risk arch test tightening, deferred only for review-budget reasons. | Quick follow-up. |
| Real Bluetooth implementation | Requires vendor SDKs (Star/Epson). Out of platform scope. | Flag to product. |

### ⚪ Not changed (verified accurate as-is)

- Wave-10 claims about `PrintService` deletion, per-role mutex, batched exec log, terminal-qualified saga key, kitchen-ticket first-class path — re-confirmed accurate.
- `HardwareTopology` page, arch-guard `no-printservice-shim`, kitchen-ticket golden test, ZPL golden test — all present and tight.

---

## 3. Verification matrix (after edits)

| Item | State |
|---|---|
| ZPL branch reachable for cross-org caller | 🟢 Now 403 (post-gating placement) |
| `LineDisplay` in Electron | 🟢 Falls through to main-process driver |
| `SaleSaga.keyFor` with no terminalId | 🟢 Throws loudly — no silent collision |
| Fresh install / cleared storage | 🟢 Auto-generates `terminal-<uuid>`; persists to localStorage |
| Bluetooth in wizard | 🟢 Removed from operator-facing options |
| Dead-letter rows | 🟢 Visible + replay/discard from HardwareDiagnostics |
| Agent timing attack | 🟢 `crypto.timingSafeEqual` |
| Customer display USB → wizard | 🟢 Classified as `customer_display`, not `receipt_printer` |

---

## 4. Known limitations of this wave

1. **CORS on the agent** (R7 second half) was not changed — still `Access-Control-Allow-Origin: *`. Restricting it needs the published-origin list from the platform settings; deferred to a small follow-up.
2. **Per-role mutex / `execAny` ring buffer / payload-store schema** (Phase A re-verification items) were not re-read in this wave because no edits depended on them. Treat as "verified accurate by prior audit, not re-verified by Wave 11."
3. **Status enum `failed`** is now used as the "discarded dead row" terminal status. This is consistent with `electron/hardware/types.ts:32` (`'pending' | 'running' | 'done' | 'failed' | 'dead'`) — `failed` was previously unused at runtime, so the choice doesn't conflict with existing semantics.
4. **`DeadLetterQueueCard` polls every 15s** — adequate for a diagnostics surface but not realtime. A future improvement would have `CommandQueue` emit an IPC event on every transition to `dead` and have the card listen.

---

## 5. Recommended next wave (Wave 12)

In priority order:
1. R1 + R8 + R12 together — single ADR-0026 PR that introduces `printClient.print({ documentType, documentId, intent })`, adds `a4_printer` and GRN, retires `useDocumentPrint` as a routing layer, drops `scanner` alias.
2. R10 — `label_templates` table + server-driven label renderer; replace `Products.tsx` inline ZPL.
3. R9 — Transport reliability policy.
4. R13 — Tighten arch tests so future shadow paths fail CI.

---

## 6. Files touched

```
agent/src/auth.ts
electron/hardware/CommandQueue.ts
electron/hardware/SaleSaga.ts
electron/hardware/discovery/classify.ts
electron/main.ts
electron/preload.ts
src/apps/platform/hardware/DeviceWizard.tsx
src/apps/platform/hardware/HardwareDiagnostics.tsx
src/components/hardware/DeadLetterQueueCard.tsx (new)
src/components/hardware/ElectronHydratorMount.tsx
src/services/hardware/drivers/DriverRegistry.ts
supabase/functions/generate-document/index.ts
docs/audit/2026-06-11-hardware-wave-11-closeout.md (this file, new)
```

No business-logic files outside the hardware/print stack were modified.
