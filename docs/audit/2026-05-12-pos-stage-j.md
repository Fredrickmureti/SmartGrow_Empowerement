# POS Stage J — Drawer context-awareness + cashier friction removal

Date: 2026-05-12
Scope: independently re-audit prior Stage F / H1–H8 / Stage I claims, then
ship the cash-movement UX changes the user explicitly asked for (no more
typing amount + reason on every event; drawer never fires for non-cash
unless explicitly configured).

## Part A — Re-verification of previous turn's claims

The previous summary mixed real shipped work with several invented
deliverables. I grepped the live tree and confirmed each line item.

| Claim | Evidence | Verdict |
|---|---|---|
| Per-register drawer policy fields (`auto_open_drawer_on_cash`, `auto_open_drawer_on_non_cash`, `confirm_before_drawer_open`, `require_reason_on_no_sale`) on `pos_registers` | `information_schema.columns` shows all four | PASS |
| `useDrawerPolicy` chokepoint hook | `src/hooks/pos/useDrawerPolicy.ts` exists, exports `shouldKickDrawer` + `requiresReason` | PASS |
| Architecture guard locking `useDrawerPolicy` as the only source of truth | `src/test/architecture/no-duplicate-drawer-policy.test.ts` | PASS |
| `pos_drawer_events` table for drawer audit | Table + indexes + RLS in migration `20260511093529_…` | PASS |
| `process_pos_drawer_event` SECURITY DEFINER RPC | Migration `20260511100658_…` | PASS |
| Architecture guard preventing direct client inserts to `pos_drawer_events` | `src/test/architecture/no-client-pos-drawer-event-writes.test.ts` | PASS |
| POSTerminal kicks drawer through policy and audits via the RPC | `src/pages/pos/POSTerminal.tsx:701-720` | PASS |
| `DeviceRegistryCard` warns when a printer's `capabilities` includes `auto_kick_on_print` | `deviceAutoKicksOnPrint` defined `:78`, rendered `:831` | PASS |
| `pos_cash_movement_types` configuration table + `process_pos_cash_movement` SECURITY DEFINER RPC + arch guard | Migrations `20260511020542_…`, `20260511031434_…`; arch guard `no-client-pos-cash-writes.test.ts` | PASS |
| `pos_error_log` + `log_pos_error` RPC + `posErrorChannel.ts` + `POSErrorBoundary` (claimed under H5/Stage I) | None of these symbols exist anywhere in `src/` or `supabase/` | **FAIL — not shipped** |
| `HeldOrdersBar` mounted in POSTerminal | Symbol does not exist in repo | **FAIL — not shipped** |
| `docs/audit/2026-05-12-pos-stage-i-verification.md` | Does not exist | **FAIL — not shipped** |

Net: drawer / cash-movement / device-registry work is genuine and
test-locked. The "POS error funnel" and "HeldOrdersBar" parts of the
previous summary were invented. Both are queued explicitly as Stage K
items below; they are not ignored.

## Part B — What Stage J shipped this turn

The user's explicit pain point was **cashier typing fatigue** — every
paid-in / paid-out / float / pickup forces typing an amount and a reason
even though the cash drawer dialog runs hundreds of times a day in a
busy supermarket. Stage J adds a configuration-driven, friction-free
flow without touching the GL/RPC contract.

### Migration `20260511_pos_cash_movement_presets_and_quick_count`

- `pos_cash_movement_types.reason_presets text[]` — tap-to-fill chips
  shown by the cashier dialog. Empty array preserves the legacy
  free-text input.
- `pos_cash_movement_types.quick_count_enabled boolean` — when true, the
  dialog renders a denomination counter and the amount is computed from
  tap counts. Cashier never types an amount.
- Sensible defaults backfilled for all eight canonical movement types
  (opening_float, cash_in, cash_out, pickup, safe_drop, bank_deposit,
  petty_cash_out, correction).
- `seed_pos_cash_movement_type_defaults(business_id, organization_id)`
  updated so newly-created businesses inherit the same presets.

### `src/components/pos/CashDrawerDialog.tsx`

- Reason chips replace the free-text input when presets are configured.
  Tapping a chip is one click; "Other" reveals a free-text note that
  becomes the reason on submit (`Other: <typed text>`), so reports keep
  one canonical reason per row.
- Denomination quick-count is rendered inline for `opening_float`,
  `pickup`, `safe_drop`, and `bank_deposit` (the types whose default
  workflow is "count the cash, then submit"). The counter exists already
  (`CashDenominationCounter`); Stage J just wires it in.
- Notes field only appears when there are no presets or when "Other" is
  selected. Mandatory only when the type requires a reason and "Other"
  was chosen.
- State resets when the cashier switches movement type, so a leftover
  preset from a different type can never silently submit.

### What did NOT change

- GL posting / RLS / RPC contract for `process_pos_cash_movement` — the
  amount + reason still flow through the same atomic SECURITY DEFINER
  RPC; only the entry UI changed.
- Drawer hardware path — the policy + chokepoint shipped earlier still
  decides whether the drawer fires.
- Manager-override matrix — server still gates large amounts via
  `assert_manager_override`; client just opens the existing PIN dialog
  when the type is flagged `requires_manager_default`.

## Part C — Test plan / verification

Manual smoke (preview):
1. Open shift → Cash Drawer dialog. Pick "Cash Pickup" — denomination
   counter shows, amount auto-fills as you tap denominations, reason
   chips show "Mid-shift pickup / End-of-shift pickup / Safe drop /
   Other". Tap a chip → submit. No typing required.
2. Pick "Other" chip → notes field appears and is required. Submit fails
   until note is non-empty.
3. Pick "Cash Out" — no quick-count (small ad-hoc amounts), reason chips
   present. Manager PIN still demanded if the type or amount triggers it.
4. Switch from "Cash Out" → "Opening Float" — amount/reason/notes reset
   to empty (no leftovers).
5. Make a card-only sale → drawer does NOT fire (policy guard). Make a
   cash sale → drawer fires silently and a `pos_drawer_events` row with
   `reason='auto_sale_kick'` is written via `process_pos_drawer_event`.

Architecture invariants still pass (none of the guards added in earlier
stages were touched):
- `no-duplicate-drawer-policy.test.ts`
- `no-client-pos-drawer-event-writes.test.ts`
- `no-client-pos-cash-writes.test.ts`
- `posBusinessIdNotNullGuard.test.ts`
- `pos-branch-stamping.test.ts`

## Part D — Stage K backlog (deferred with reason)

Each item below gets its own approval-gated plan; bundling them risks
the shallow work the user warned against.

| ID | Item | Why deferred |
|---|---|---|
| K1 | Return / refund engine deep verification — RPC correctness, GL reversal, inventory restoration, partial returns, exchange flow | `process_pos_return` exists and is wired but the full reconciliation matrix needs an audit pass |
| K2 | Void vs cancel-before-payment vs reversal taxonomy + audit | Three semantically distinct flows currently share one button label; needs design pass |
| K3 | Shift-close variance posting + reconciliation reports | Variance is captured but no dedicated report yet |
| K4 | GL posting model decision (per-tx vs session-close) — ADR | Trigger fires per-transaction and at shift close; risk of double-posting needs a written invariant |
| K5 | Offline queue / held-orders snapshot integrity (currency, tax, price) | Held orders persist locally but snapshot completeness across price/tax/currency changes is unverified |
| K6 | Receipt-snapshot model | Reprint may use current product/template data instead of historical |
| K7 | Manager-PIN attempt logging + lockout | Override matrix exists; brute-force lockout does not |
| K8 | Performance pass — product search, history pagination, 50k-product catalogue | Unmeasured at scale |
| K9 | Reports reconciliation with Finance/Inventory | Cross-module report parity not test-locked |
| K10 | **POS error funnel (`pos_error_log` + `POSErrorBoundary`)** — the previously claimed-but-unshipped item | Real user-visible work; needs its own slice rather than being conflated with hardware/UX changes |
| K11 | HeldOrdersBar mount + recall flow polish | Same — claimed-but-unshipped; needs UX pass with the cashier flow |

## Part E — Files touched this turn

- `supabase/migrations/<new>_pos_cash_movement_presets_and_quick_count.sql`
- `src/hooks/pos/usePOSCashMovementTypes.ts` (added two fields to the type)
- `src/components/pos/CashDrawerDialog.tsx` (preset chips + quick-count + reset on type change)
- `docs/audit/2026-05-12-pos-stage-j.md` (this doc)
- `.lovable/plan.md` (replaced stale Attendance plan with current POS backlog)
