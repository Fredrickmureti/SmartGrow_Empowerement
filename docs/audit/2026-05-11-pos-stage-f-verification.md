# POS Stage F — Zero-Trust Verification

Date: 2026-05-11
Auditor: independent re-audit of the previous agent's "Context-Aware Drawer" claims.
Method: queried live DB, ripgrepped every call site, read each cited file, ran the existing build/test surface.

## Verdict legend
PASS — claim is real, end-to-end wired, defensible.
MINOR — works, but a small follow-up is filed.
SHALLOW — partially wired; behavior reachable but incomplete.
BROKEN — claim is false.

---

## Part 1 — Stage F claims

### 1. Migration applied — **PASS**
DB confirms on `public.pos_registers`:
- `auto_open_drawer_on_cash boolean NOT NULL DEFAULT true`
- `auto_open_drawer_on_non_cash boolean NOT NULL DEFAULT false`
- `require_reason_on_no_sale boolean NOT NULL DEFAULT true`
- `confirm_before_drawer_open boolean NOT NULL DEFAULT false`

`public.pos_drawer_events` exists with full shape (`organization_id`, `business_id`, `branch_id`, `register_id`, `shift_id`, `transaction_id`, `reason`, `reason_note`, `triggered_by`, `triggered_at`, `hardware_success`, `hardware_result jsonb`). `relrowsecurity = true`. Two policies present:
- INSERT: `EXISTS user_business_access uba WHERE uba.business_id = business_id AND uba.user_id = auth.uid()`
- SELECT: same predicate.
Indexes: `(register_id, triggered_at DESC)`, `(shift_id)`, `(business_id, triggered_at DESC)` — sufficient for shift reports + reconciliation queries.

### 2. `useDrawerPolicy` is the only resolver — **PASS**
`rg "auto_open_drawer_on_cash"` outside `useDrawerPolicy.ts` returns only:
- `EditRegisterDialog.tsx` — settings form (write-side, expected).
- `integrations/supabase/types.ts` — generated.
No other component reads the raw column or duplicates the kick decision. New guard test (`src/test/architecture/no-duplicate-drawer-policy.test.ts`) enforces this going forward.

### 3. Auto-kick fires on cash, not on card — **PASS**
`POSTerminal.tsx:570-720`: after `process_pos_transaction` succeeds, `drawerPolicy.shouldKickDrawer(payments)` is consulted. On true → `openDrawerHw()` → `sound.play("cash_drawer_open")` → audit insert into `pos_drawer_events` with `reason: "auto_sale_kick"`, `transaction_id`, `shift_id`, `hardware_result`. The whole block is wrapped in try/catch and the hardware promise has `.catch` → failures never block the next sale and still produce an audit row with `hardware_success=false`.

### 4. No reason prompt on routine cash sales — **PASS**
`CashDrawerDialog` is never opened by `handlePaymentComplete`. The kick path is inline and modal-free. The dialog still gates `cash_movement` reasons (correct — fraud control).

### 5. Printer does NOT kick the drawer implicitly — **PASS**
`rg "openDrawer\s*[:=]\s*true"` returns zero matches. `PrinterService.print()` honours `receipt.openDrawer` only if a caller passes it; no caller does. Card / mobile sales that print receipts produce zero drawer events.

### 6. Audit trail is real — **MINOR**
Insert succeeds end-to-end via RLS. The current write is a direct client `supabase.from("pos_drawer_events").insert(...)` instead of an RPC. RLS is sufficient because the predicate matches the same access check the RPC would enforce, but it skips the chance to canonicalize hardware-result shape server-side. Filed as G-deferred: optional `process_pos_drawer_event` RPC + arch guard.

### 7. Cashier permission honored — **PASS**
`useDrawerPolicy.shouldKickDrawer` returns false when `cashier.can_open_cash_drawer === false`, regardless of tender. No audit row is written in that case (intentional — no hardware action attempted; the failed-policy branch is logged via the cashier-permission system, not the hardware audit table).

---

## Part 2 — Cashier-fatigue sweep (G1–G12, fast-pass verdicts)

| Item | Verdict | Notes |
|------|---------|-------|
| G1 Receipt auto-print | **PASS** | `auto_print_receipt` setting exists in `usePOSSettings` + merged receipt settings, honored in `POSTerminal` lines 779/820. |
| G2 Walk-in customer = zero clicks | **PASS** | `CustomerSelectDialog` is opened only on explicit action; no auto-mount on cart start. |
| G3 Barcode multi-qty | **SHALLOW** | Same scan increments qty (cart upsert), but `qty*sku` prefix not parsed in `useBarcodeScanner`. Filed for follow-up. |
| G4 Payment defaults / exact-cash key | **SHALLOW** | `F9` currently opens the cash drawer (legacy). Exact-cash one-keystroke is missing. Re-binding F-keys would be a UX regression without a release note — filed, not done in this slice. |
| G5 Held / recall | **PASS** | `HeldOrdersBar` recalls in one click; hold auto-names. |
| G6 Discount / price-override gating | **PASS** | Routes through `useManagerOverride` + `pos_override_matrix` (Stage 8.6). Friction is intentional and threshold-gated. |
| G7 Void / return prompts | **PASS** void (dropdown from `pos_void_reasons`), **SHALLOW** return-by-receipt-scan (Stage 4 doc lists it as deferred). |
| G8 Cash movement entries | **PASS** dropdown from `pos_cash_movement_types`; reason required (correct — fraud surface). |
| G9 Shift open / close | **SHALLOW** | "Same as last close" prefill not implemented. Expected-cash auto-computed (good). |
| G10 Hardware confirmations | **PASS** | No "Are you sure?" dialogs in the default path; `confirm_before_drawer_open` opt-in only. |
| G11 Errors / toasts | **MINOR** | Toasts used; not yet a single funneled error boundary with sound cues. |
| G12 Keyboard contract | **PASS** | Shortcuts in `usePOSKeyboardShortcuts` are wired (F2, F4, F9). Help overlay (`?`) is the next slice. |

**Conclusion of sweep**: Stage F's narrow goal (drawer no longer demands typing on every cash sale) is fully delivered. The wider cashier-fatigue principle is mostly upheld; the SHALLOW items (G3, G4, G7-return, G9, G11) are listed in `.lovable/plan.md` Stage G follow-ups.

---

## Part 3 — Hardware reality

- **Software-level toggle**: implemented per-register, per-tender. Verified above.
- **Printer-firmware "open on every print"**: outside browser control. The runtime cannot disable it. Documented per supported model:
  - **Star TSP100 / TSP143** — "futurePRNT Configuration Utility" → *Cash Drawer* → set **Cash Drawer Operation = Document Top** (not "Always") or **Disabled**. After this, the drawer fires only when our software issues an explicit ESC/POS kick (which we now do).
  - **Epson TM-T20/T88** — "TM Utility" → *Cash Drawer Settings* → uncheck "Open at top/bottom of receipt".
  - **Citizen CT-S310** → power-on self-test menu → *Drawer kick at print = OFF*.
  - **Bixolon SRP-350** → "Bixolon Unified Utility" → *Drawer Kick* tab → set to *None*.
  Follow-up: surface a warning in `DeviceRegistryCard` if a registered printer exposes an `auto_kick_on_print` capability hint (deferred).
- **Manual confirmation prompt**: `confirm_before_drawer_open` setting exists (default OFF). No re-introduction of the click cost in the default flow.
- **Future IoT path**: the same context-policy contract (`useXxxPolicy` hook + per-register settings + audit table) applies cleanly to payment terminals and scales via `hardwareProxy`.

---

## Stage G follow-ups (deferred, tracked here)

1. `qty*sku` barcode prefix parsing in `useBarcodeScanner`.
2. Exact-cash one-keystroke (rebind discoverable F-key with release note).
3. Return-by-receipt-scan flow in `ReturnDialog`.
4. "Same as last close" denomination prefill on shift open.
5. POS error boundary with sound-cue funnel (`Try again` / `Call manager` / `Hardware offline`).
6. Optional `process_pos_drawer_event` RPC + arch guard — replaces direct client insert.
7. `DeviceRegistryCard` warning for printer-firmware-level "open on every print".
8. Help overlay (`?` key) listing every keyboard shortcut.
