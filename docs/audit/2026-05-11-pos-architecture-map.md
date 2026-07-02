# POS Architecture Map & Decorative-Feature Verdict

Date: 2026-05-11
Status: Stage 1 deliverable of `.lovable/plan.md`. Builds on `2026-04-27-pos-deep-audit-stage1.md` (still valid for hook inventory) and adds an explicit **REAL / SHALLOW / DECORATIVE** verdict per surface.

Verdict legend:
- **REAL** — wired to a server-side write path, branch/business scoped, GL/inventory effects traced, audited.
- **SHALLOW** — wired but missing one or more of: snapshot, idempotency, threshold gating, audit row, GL effect, configurability.
- **DECORATIVE** — UI exists but does not produce the effect a user would reasonably expect.

---

## 1. Surfaces

### 1.1 POS Dashboard (`/pos`, `src/pages/pos/POS.tsx`)
- Hooks: `usePOSRegisters`, `usePOSShifts`, `usePOSDashboardStats`, `usePOSReadiness`, `usePOSSound`, `usePOSSettings`.
- RPCs: `ensure_pos_ready_for_business` (via readiness banner).
- Tables read: `pos_registers`, `pos_shifts`, `pos_daily_summary`.
- GL/inv effects: none direct.
- Verdict: **REAL** for navigation; readiness banner is real.
- Gap: readiness check does not validate per-tender GL mapping (principle A2).

### 1.2 Terminal (`/pos/terminal/:registerId`, `POSTerminal.tsx`, 1836 lines)
- Hooks: 25+ (cart, products, transaction, held, settings, loyalty, hardware, security, …).
- RPC: `process_pos_transaction` (only paid-write path).
- Verdict: **SHALLOW** — depth is in DB, but UX layer is mouse-heavy and lacks:
  - Global F-key shortcut layer (U2). Today only `Enter` in search triggers barcode add.
  - `qty *` multiplier on barcode (`3*1234567`).
  - Persistent held-orders bar (U7).
  - Single-screen pay panel (U6) — currently a dialog.
  - Idempotency key on commit (O5).
  - Receipt snapshot (O4 / C1).
- Decorative buttons: none in this surface — every button calls a real hook.

### 1.3 History dialog (`TransactionHistoryDialog.tsx` + `usePOSTransactionHistory`)
- RPC/queries: paginated read of `pos_transactions` joined to items/payments.
- Filters: completed / voided / search / date.
- Verdict: **SHALLOW** — works, but:
  - Reprint uses live product/template data (no snapshot).
  - No saved views, no payment-method filter, no cashier filter, no export.
  - Detail view does not surface JE link, stock-movement link, or override audit rows.

### 1.4 Return flow (`ReturnDialog.tsx` + `usePOSReturns` + `process_pos_return`)
- Verdict: **SHALLOW**. Real RPC, real inventory + GL reversal. But:
  - `Process Return` button is **REAL** (calls server RPC). Not decorative.
  - No QR-receipt scan path.
  - No `v_pos_returnable_qty` view → over-return prevention relies on UI clamping.
  - Refund tender freely selectable (R5 violated).
  - Reason codes free-text only; no `pos_return_reasons` table.
  - PIN gating tied to a single boolean (`return_requires_manager`), not amount-thresholded.

### 1.5 Void flow (`usePOSVoid` + `process_pos_void`)
- Verdict: **SHALLOW**. RPC exists, manager PIN gateable, but:
  - Same-shift-only window not enforced server-side (V1).
  - VOID reprint watermark unverified (V5).
  - Void/Return distinction not enforced (a void of a partially-returned txn? unspecified).

### 1.6 Cash drawer dialog (`CashDrawerDialog.tsx` + `usePOSCashDrawer` + `pos_add_cash_movement`)
- Buttons: Add cash · Remove cash · Add float · Cash pickup · History.
- Verdict per button:
  - Add cash → **REAL** (`cash_in` movement type).
  - Remove cash → **REAL** (`cash_out`).
  - Add float → **REAL** (`float`).
  - Cash pickup → **REAL** (`pickup`).
  - History list → **REAL**.
- Gaps:
  - Missing types: `drop`, `petty_payout`, explicit `opening_float`/`closing_count` (S3).
  - No reason-required gate above threshold; no manager-PIN gate above threshold.
  - No expected-vs-counted comparison surfaced live.

### 1.7 Open / Close shift (`OpenShiftDialog.tsx`, `CloseShiftDialog.tsx`)
- Verdict: **SHALLOW**.
- Open: counts opening float — REAL.
- Close: denomination counter REAL; trigger `trg_pos_shift_close_journal` posts JE — REAL; `pos_shift_close_errors` capture — REAL.
- Gaps:
  - No DB partial-unique index for one-active-shift-per-(register, cashier) (S1).
  - Block-on-held / unposted / missing-count list not enforced (S7).
  - Variance threshold + manager PIN gate not configurable (S4).
  - Closed-shift read-only RLS not verified (S5).

### 1.8 Reports (`POSReports.tsx` + `usePOSEnhancedReports` + `usePOSReports` + `usePOSReportViews`)
- Verdict: **SHALLOW** — comprehensive set of widgets but:
  - Diverges from the unified Finance report engine (RP1).
  - Reports do not link to GL JEs (RP2).
  - No daily reconciliation report (A4).

### 1.9 Settings (`POSSettings.tsx` and many cards)
- Cards present: Cashier mgmt, Denomination, Device registry, eTIMS, Loyalty, Offline, Restaurant, Security, Shift integrity, Sound.
- Verdict: **SHALLOW**.
- Each card writes to a real settings table — REAL.
- But **runtime-use audit pending**: do all toggles flip behavior? (Stage 17 task).
- Missing: `pos_manager_override_thresholds` editor (M3), `pos_return_reasons` editor (R3).

### 1.10 Hardware / IoT (`useHardwareProxy`, `useDeviceRegistry`, `agent/`, drivers)
- Verdict: **SHALLOW to DECORATIVE** — depends on backend.
- ESC/POS + browser-print fallback REAL.
- Many driver classes (`star`, `citizen`, `bixolon`, `epson`, scales, payment terminals) declared but not all wired through to UI status. Stage 14 will mark unwired ones `Coming soon` and disable.

### 1.11 Floor plan / Kitchen / Table bookings
- Restaurant-mode, out of scope for this audit. Tracked under prior plan's Stage 5.

---

## 2. Risk-ranked overhaul list (drives Stages 2–18)

1. Cashier UX (Stage 2) — Terminal SHALLOW on UX is the loudest user-visible gap.
2. Receipt snapshot + idempotency (Stage 3) — Terminal SHALLOW on commit safety.
3. Returns hardening (Stage 4) — three real R-principle gaps.
4. Void/return separation (Stage 5).
5. Cash control deepening (Stage 6).
6. Shift correctness (Stage 7).
7. Reports unification (Stage 17).
8. Hardware honesty pass (Stage 14).

Stage 1 ends here. Stage 2 begins immediately.

---

## Stage B — Branch Isolation (final state)

### Server-side enforcement (defense layer 1)

Two migrations implement the branch-mutation boundary:

- `20260516115704_*` — helper `assert_pos_caller_branch_access(uuid)` +
  generic trigger `tg_assert_pos_branch_caller_access` attached to
  `pos_shifts`, `pos_sessions`, `pos_cashiers`, `pos_kitchen_orders`,
  `pos_table_bookings`, `pos_waitlist`, and the special
  `tg_assert_pos_payment_method_scope` trigger on `pos_payment_methods`
  (NULL-branch rows = org-admin only).
- `20260516120830_*` (Stage B3-complete) — extends the same trigger to
  the money-handling surface: `pos_transactions`, `pos_transaction_items`,
  `pos_transaction_payments`, `pos_drawer_events`, `pos_cash_movements`,
  `pos_manager_overrides`.

`service_role` / `auth.uid() = NULL` contexts bypass — migrations and
background jobs still work. JWT callers must satisfy
`user_can_access_branch(uid, NEW.branch_id)` or the row write raises
`42501 insufficient_privilege`.

### App-layer scoping (defense layer 2)

`usePOSRegisters`, `usePOSShifts`, `usePOSCashiers`, `useActivePOSRegister`,
`useActiveOrDefaultRegister`, `useKitchenDisplay`, `useTableBookings`,
`useWaitlist` all filter by `currentBranch.id` and include it in their
`queryKey`. Realtime channels (`useTerminalSession`, `useWaitlist`, KDS,
bookings) are keyed by org/business/branch and drop foreign-branch payloads.

### HQ overseer mode (Stage B4)

`usePOSOverseer` returns `canOversee = role in (owner, admin, super_admin)`.
The three list hooks short-circuit to `[]` for non-overseers in a
no-branch state — no implicit company-wide leakage. The POS dashboard
shows an amber "HQ oversight mode — read-only" banner and disables the
Open Terminal button with a "Switch to <branch> to operate" tooltip when
`isOverseeing` is true. Mutations remain blocked by Stage B3 triggers
regardless of UI state.

### Verification

- `src/hooks/pos/__tests__/posBranchIsolation.test.ts` — 10 static guards
  covering hook scoping, terminal guard, realtime keying, restaurant
  surfaces, trigger presence per table, overseer wiring, and SQL test
  presence.
- `supabase/tests/pos_branch_isolation_test.sql` — pg_catalog assertion
  that the helper, generic trigger function, all 12 per-table triggers,
  and the payment-method scope trigger are live.

### Deferred (separate tickets)

- Stage B5 — `POSSettings.tsx` Company/Branch/Register accordion split
  with `ScopeOwnershipBadge` on disabled CoA/GL/tax-mapping fields.
- `useFloorPlan` branch scoping (requires `pos_floors.branch_id`
  schema change).
- Cross-branch live transfer of an open shift.

---

## Stage R — Re-audit 2026-05-16 (zero-trust pass)

Second-layer audit verified Stage B claims and closed the remaining gaps.

### Verified solid (no change)
- `assert_pos_caller_branch_access` + `tg_assert_pos_branch_caller_access` correctly
  preserve `auth.uid()` through `SECURITY DEFINER` (Postgres only changes the
  role, not the JWT subject), so triggers fire even when called from within
  POS RPCs.
- All 12 Stage B / B3-complete tables remain trigger-guarded.
- `usePOSRegisters`, `usePOSShifts`, `usePOSCashiers`, `useActivePOSRegister`,
  `useActiveOrDefaultRegister` correctly short-circuit in no-branch context for
  non-overseers.

### Closed in Stage R1 (DB)
| Surface | Gap | Fix |
|---|---|---|
| `pos_held_transactions` | No B trigger — held sale in HQ resumable in Branch A | `zzz_assert_pos_branch_caller_access` attached |
| `pos_table_sessions` | Same | Same |
| `pos_cashier_registers` | No caller-authority check; only branch-match constraint | `branch_id` column + stamp trigger + `zzz_assert_pos_branch_caller_access` |
| `pos_floors` | No `branch_id` at all — floors shared across branches | `branch_id` column (backfilled from register), stamp trigger, `zzz_assert_pos_branch_caller_access` |
| `pos_gift_cards`, `pos_discounts` | No `branch_id`; no scope contract | `branch_id` column + `tg_assert_pos_scope_caller_access` (NULL → org-admin, non-null → branch access) |

### Closed in Stage R3 (App)
- `useFloorPlan` now consumes `currentBranch`, gates non-overseer no-branch reads,
  filters `pos_floors` + `pos_tables` + `pos_table_sessions` by `branch_id`,
  and stamps `branch_id` on create.

### Deferred (tracked, not blocking)
- **R2** — explicit `PERFORM assert_pos_caller_branch_access` as the first
  executable statement inside each POS RPC. The Stage B triggers already catch
  every write path; this is pure defense-in-depth and a separate, surgical PR
  per RPC.
- **R4** — `POSSettings.tsx` Company/Branch/Register accordion split with
  `ScopeOwnershipBadge`. Large UX refactor; will land as its own ticket.
- **R5b** — pgTAP/Deno behavior tests that fake `auth.uid()` and assert `42501`.
  Static guards are extended in this turn; behavior tests need a dedicated
  test harness.
- **G9 (out of POS scope)** — `stock_movements` and `journal_entries` have no
  caller-authority trigger. POS RPCs stamp the right `branch_id`, so leakage is
  prevented from POS. A direct PostgREST write from a misbehaving non-POS
  surface to those tables would still post to a foreign branch — that's a
  Finance/Inventory module audit, separate from this one.

### Verification
- `supabase/tests/pos_branch_isolation_test.sql` — extended to 6 checks
  covering the 4 new branch-trigger tables, the 2 scope-trigger tables, and
  the new `tg_assert_pos_scope_caller_access` helper.
- `posBranchIsolation.test.ts` — extended to 12 tests; new assertions cover
  the Stage R1 trigger surface and Stage R3 `useFloorPlan` wiring.

### Service-role bypass note
`auth.uid() IS NULL` (true service-role calls and migrations) still bypass.
This is intentional and required for the offline-sync flush edge function;
that function is responsible for forwarding the captured `branch_id` and
should not be trusted to elevate beyond what the original cashier could do.
