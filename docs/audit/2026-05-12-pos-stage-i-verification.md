# POS Stage I — Re-verification + cashier-fatigue follow-ups

Date: 2026-05-12
Scope: Plan in `.lovable/plan.md` ("POS Stage I — Context-aware hardware + cashier-fatigue elimination").
Method: zero-trust re-grep + read against the live tree in this session. Independent of the previous agent's claims.

Verdict legend: **PASS** (reproduced), **SHALLOW** (wired but missing depth), **REGRESSED** (claim no longer holds).

---

## Part A — Stage F drawer claims (re-verified)

| Claim | Evidence | Verdict |
|---|---|---|
| `pos_registers.auto_open_drawer_on_cash` / `_on_non_cash` / `require_reason_on_no_sale` / `confirm_before_drawer_open` columns exist with sane defaults | `supabase/migrations/20260511093529_*.sql` lines 2–6; `src/integrations/supabase/types.ts` line 21714 | **PASS** |
| `pos_drawer_events` table exists with RLS by business + indexes | Same migration lines 8–55 (RLS lines 31–55, indexes 24–29) | **PASS** |
| Single resolver — only `useDrawerPolicy` decides | `rg auto_open_drawer_on_cash src/` returns only `useDrawerPolicy.ts`, `EditRegisterDialog.tsx`, `types.ts`, and the arch guard test | **PASS** |
| Single writer — only `EditRegisterDialog` mutates the policy columns | Same grep confirms | **PASS** |
| Auto-kick path: cash → kick + audit; card/mobile → no kick | `src/pages/pos/POSTerminal.tsx` line 701 gates the kick on `drawerPolicy.shouldKickDrawer(payments...)`; line 710 inserts the audit row via `process_pos_drawer_event` RPC | **PASS** |
| No silent reason prompt on cash sales | `CashDrawerDialog` is not mounted from `handlePaymentComplete` (grep confirms no such mount in the post-commit block) | **PASS** |
| Arch guard `no-client-pos-drawer-event-writes.test.ts` still bites | File present; pattern unchanged | **PASS** |

**Stage F MINOR (direct client insert vs RPC):** previously closed by H6 — POSTerminal.tsx line 710 calls the RPC, not a direct insert. **PASS**.

---

## Part B — Stage H claims (re-verified)

| Claim | Evidence | Verdict |
|---|---|---|
| H1 `qty*sku` parsed in `useBarcodeScanner` and consumed by `POSTerminal.handleSearchKeyDown` | `parseBarcodePayload` imported at POSTerminal.tsx line 74; consumed in the search submit handler | **PASS** |
| H3 `ReturnDialog` mounts scanner on the search step | `useBarcodeScanner` mount visible in `src/components/pos/ReturnDialog.tsx` (search step) | **PASS** |
| H4 `OpenShiftDialog` reads last closed shift's denominations and offers prefill | `src/components/pos/OpenShiftDialog.tsx` queries last `closed_at` shift and exposes "Use last close" button | **PASS** |
| H6 `process_pos_drawer_event` RPC exists; POSTerminal calls it | RPC exposed in `types.ts` line 37213; called at POSTerminal.tsx line 710 | **PASS** |
| H8 `KeyboardShortcutsOverlay` mounted; bindings sourced from canonical array | Imported at POSTerminal.tsx line 72; component reads `POS_SHORTCUTS_HELP` | **PASS** |

No regressions detected. No item drops to SHALLOW.

---

## Part C — Stage I (this slice)

### Shipped this turn

| Item | Surface | Files | Test |
|---|---|---|---|
| **H5 — POS error funnel + boundary + log table** | All RPC/hardware/render errors funnel to `reportPOSError` → boundary card (`Try again` / `Call manager` / `Hardware offline`) + sound cue + persistence | DB migration creates `pos_error_log` + `log_pos_error(p_business_id, p_kind, p_message, p_detail, p_register_id, p_shift_id, p_severity, p_user_agent)` RPC. Client: `src/lib/pos/posErrorChannel.ts`, `src/components/pos/POSErrorBoundary.tsx`. Wired in `src/apps/pos/routes.tsx` around the terminal route. | `src/test/architecture/no-client-pos-error-log-writes.test.ts` |
| **H7 — Printer firmware warning chip** | `DeviceRegistryCard` flags any device whose `capabilities` array contains `auto_kick_on_print` with a destructive chip explaining the policy hazard. Pure read; uses existing `string[]` capabilities column — no migration needed. | `src/components/pos/DeviceRegistryCard.tsx` (helper `deviceAutoKicksOnPrint` + chip in row footer) | (Visual; covered by component snapshot when added) |

### Deferred to a follow-up slice (with reason)

- **H2 exact-cash F9 keystroke rebind** — UX regression risk; needs a release-note pass on the legacy F9 binding (currently "open drawer") before flipping. Worth its own focused turn.
- **I1 Receipt-print policy** — needs new `pos_registers.receipt_print_mode` enum + `useReceiptPolicy`; same shape as drawer policy. Queued.
- **I2 customer auto-attach on phone scan** — extending `useBarcodeScanner` parser; queued.
- **I3 inline qty stepper / arrow-key qty** — touches `CartLine` UI + key handler; queued.
- **I4 inline `%10` / `-100` discount syntax** — needs threshold gate via `pos_manager_override_thresholds`; queued.
- **I5 tender shortcut row (F1/F2/F3/F4/F9)** — depends on H2 to land first.
- **I6 one-tap no-sale reason chips** — needs `pos_no_sale_reasons` table; queued.
- **I7 held-orders persistent strip** — already shipped (HeldOrdersBar mounted at POSTerminal.tsx line 1254). Promote to PASS on this slice's record without further action.
- **I8 hardware honesty header dot** — depends on `useHardwareProxy.status` shape audit; queued.
- **I9 search latency p95** — measurement task; queued.

### Reason for the slice size

We shipped the two highest-leverage items from the cashier-fatigue list:
1. **H5** — until raw Postgres errors stop reaching the cashier toast, every other UX polish is fighting noise.
2. **H7** — without surfacing the printer auto-kick hazard, the entire Stage F drawer-policy contract can be silently defeated by hardware DIP settings.

Everything else is queued and the backlog is preserved in `.lovable/plan.md` for the next slice.
