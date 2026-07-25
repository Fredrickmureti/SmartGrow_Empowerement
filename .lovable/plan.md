
# Employee Loan Lifecycle — Architectural Consolidation

## Reconstructed lifecycle (canonical)

Every enterprise ERP treats an employee loan as a linear, event-sourced instrument. This is the target model — one state machine, one governance path, one accounting path, one audit trail.

```text
                     ┌────────── reject ───────┐
draft/requested → pending_approval → approved → awaiting_disbursement → disbursed/active
                     │                  │              │                    │
                     └── cancel ────────┴─── cancel ───┘                    │
                                                                            ▼
                                             in_arrears ⇄ active → settled / written_off / restructured
                                                          │                                │
                                                          └── pause/resume (deduction only, not state) ─┘
```

Each arrow is a **business event** written to `loan_lifecycle_events` and emitted to `business_event_outbox`. Each event owns a single responsibility:

| Event | Owner role | Governance check | Accounting impact | Reversible? |
|---|---|---|---|---|
| `loan.requested` | Employee / HR | none | none | yes (cancel) |
| `loan.approved` | HR / Payroll Manager | `loan.approve`, `loan.approve_self_benefit` | none | yes (cancel while `approved`) |
| `loan.authorized` | Finance / Treasury | `employee_loan.authorize_disbursement` | none (control only) | yes (cancel) |
| `loan.disbursed` | Finance / Treasury (executes) | none — pre-cleared by authorize | JE: Dr Loan Receivable / Cr Bank (or Disbursement Clearing) | no (compensate via write-off or repayment) |
| `loan.repaid` (payroll) | Payroll engine | none — auto | JE: Dr Bank/Payroll Clearing / Cr Loan Receivable + Interest Income | no |
| `loan.repaid` (manual) | Finance | `employee_loan.record_manual_repayment` | same | no |
| `loan.settled` | Finance | none if balance≤0 | JE: closes any residual clearing | no |
| `loan.written_off` | Finance + co-signer (dual control) | `employee_loan.write_off` | JE: Dr Bad-debt / Cr Loan Receivable | no |
| `loan.restructured` | HR + Finance | `employee_loan.restructure` | schedule regeneration; JE only if principal/interest changes | supersedes prior schedule |
| `loan.paused/resumed` | Payroll | none | none (defers payroll deduction only) | yes |

Authorization and disbursement are **two different events**: authorization is a control gate (Finance clears the loan for release; no money moves), disbursement is the money movement (posts to GL and Bank). This mirrors SAP FI-CA release/payment, Oracle HCM approve/disburse, and Dynamics 365 F&O two-step advance workflows.

## Drift identified in the current implementation

Verified against the live DB and repo:

1. **Solo governance is silently overridden by explicit policy rows.** Org `Joshua Holdings` is `governance_mode='solo'`, but `self_action_policy` has explicit `mode='block'` rows for `employee_loan.authorize_disbursement`, `write_off`, `restructure`, `refinance`, `record_manual_repayment`. `governance_assert_not_self` prefers explicit policy over the Solo-mode auto-allow branch, so a one-person org cannot authorize its own loans. This is the true source of the `403 GOV_SELF_ACTION` — not stale signatures (those are already correct in the DB) and not a duplicate governance path.
2. **`loan-gl` returns 404 because it is not deployed** to this project (the code exists in `supabase/functions/loan-gl/` but no Supabase deployment covers it), and more importantly the whole edge function is architecturally out of place: this stack routes app-internal server logic through TanStack server functions and canonical DB RPCs, not per-family Deno edge functions. GL posting for a loan is not a networked concern.
3. **UI enables Authorize and Disburse concurrently.** `LoanDetailDrawer` sets `canAuthorize = status==='approved'` and `canDisburse = status ∈ {approved, awaiting_disbursement, active}`. That lets a user skip authorization on an `approved` loan, which is the exact drift the two-step model exists to prevent.
4. **Two competing lifecycle emitters.** `employee_loan_lifecycle_*` RPCs write to `loan_lifecycle_events`; the edge function separately updates status via `employee_loan_mark_disbursed` and writes its own JE. There is no single writer, so ordering, idempotency, and the outbox are not guaranteed.
5. **GL account resolution is bespoke to loan-gl.** `_shared/loan-gl/handlers.ts` re-implements a three-tier fallback for `default_account_settings` instead of calling the canonical `resolve_default_account` RPC used elsewhere in Finance.
6. **No `business_event_outbox` emission for loan lifecycle** — approvals, authorization, disbursement, repayment, settlement, write-off never fan out to downstream subscribers (notifications, integrity monitors, external ERPs).

## Execution plan

Each phase is verified before the next begins. All server logic uses RPCs (DB) or TanStack server functions (app); no new edge functions.

### Phase L1 — State machine hardening (DB)
- Create `public.employee_loan_state_transitions` view enumerating legal `(from_status, event, to_status)` tuples. Wrap every `employee_loan_lifecycle_*` RPC with a single `_loan_assert_transition(_loan_id, _event)` helper that FOR UPDATE-locks the row and rejects illegal moves with `HINT='LOAN_STATE_INVALID'`.
- Split disbursement into two distinct RPCs:
  - `employee_loan_authorize_disbursement(_loan_id)` — `approved → awaiting_disbursement`, records `authorized_by/authorized_at`, no GL side effect.
  - `employee_loan_disburse(_loan_id, _bank_account_id, _value_date)` — `awaiting_disbursement → active`, posts JE via `_loan_post_disbursement_je` (see L3), sets `disbursed_at`, `disbursement_journal_entry_id`.
- Every RPC writes a `loan_lifecycle_events` row and emits a `business_event_outbox` row (`loan.requested|approved|authorized|disbursed|repaid|settled|written_off|restructured`).

### Phase L2 — Governance path unification
- Keep `governance_assert_not_self` / `governance_assert_not_subject` as the only SoD entry points; do not add a second path.
- Fix the Solo-mode/explicit-policy interaction so a Solo org auto-allows even when a stale explicit `block` row exists for the actor's role. Options in order of preference:
  1. Skip explicit `self_action_policy` rows for `organization_id` whose org is in `solo` mode with a single active member, and audit `sod.self_action_auto_allowed` with `source='solo_override_stale_policy'`.
  2. Add a one-time DB migration that removes `applies_to_role IS NULL, mode='block'` policy rows for orgs in Solo mode, and a trigger that prevents such rows from being created while the org stays Solo.
- Register any missing action keys (`loan.disburse`, `loan.settle`) in `governance_action_registry` so the catalogue and UI overrides remain complete.
- Add regression tests in `supabase/tests/loan_policy_and_lifecycle_test.sql` covering: Solo auto-allow overrides stale explicit `block`; Standard warn path; Strict block with valid co-signed override consuming exactly once.

### Phase L3 — Finance posting via canonical engine
- Retire `supabase/functions/loan-gl`, `post-loan-disbursement`, `post-loan-interest-accrual`, `post-loan-settlement` and `_shared/loan-gl/`. Update `useEmployeeLoans` to stop invoking edge functions.
- Introduce DB-side posters as `SECURITY DEFINER` RPCs, all going through `resolve_default_account` for account resolution:
  - `_loan_post_disbursement_je(_loan_id, _bank_account_id, _value_date)` — Dr Loan Receivable, Cr Bank.
  - `_loan_post_repayment_je(_repayment_id)` — called from payroll posting and from `employee_loan_record_manual_repayment`.
  - `_loan_post_settlement_je(_loan_id)` and `_loan_post_writeoff_je(_loan_id)`.
- Each poster is idempotent on `(source_type, source_id[, reference])` and returns the JE id. The lifecycle RPC calls the poster, updates the loan row, writes the event, emits the outbox message — atomically in one transaction.
- App calls the lifecycle RPCs directly via `supabase.rpc(...)` (or a TanStack server function when we need cross-module orchestration such as bank-file generation). No new edge function.

### Phase L4 — UI as a state-driven control center
- Replace the per-button `canX` booleans in `LoanDetailDrawer` with a single `getAvailableActions(loan)` derived from the state machine in L1, exported from `src/lib/hr/loanStateMachine.ts` and unit-tested.
- Actions rendered strictly by state:
  - `draft/requested/pending_approval` → Approve, Reject, Cancel.
  - `approved` → Authorize disbursement, Cancel.
  - `awaiting_disbursement` → Disburse (with bank account + value date), Cancel authorization (reverts to `approved`, audit-logged).
  - `active/in_arrears` → Pause/Resume, Manual repayment, Restructure, Settle (only when balance ≤ tolerance), Suspend, Write-off (behind dual-control dialog).
  - `settled/written_off/cancelled` → read-only, show final JE links.
- Replace toasts on governance failures with `parseGovernanceError` (already present) so `GOV_SELF_ACTION` renders as "Self-approval blocked" with an "Request override" link into `SelfActionOverrideDialog`.

### Phase L5 — Event fan-out and audit
- `business_event_outbox` becomes the single downstream contract. Existing consumers (notifications, integrity monitor) subscribe here; `dispatchLoanNotification` becomes a subscriber, not a caller from the hook.
- Nightly `finance_integrity_reports` job reconciles `sum(loan.outstanding_balance) = balance(Loan Receivable account)`; drift raises a finding.
- Retire `hr_notify_loan_event` direct RPC in favour of an outbox-driven notifier so approve/authorize/disburse/repay/settle all fan out uniformly.

### Phase L6 — Cleanup & guards
- Delete the four `supabase/functions/*loan*` folders and their references.
- Add an architecture test that fails if any code under `src/` imports `supabase.functions.invoke("loan-gl"|"post-loan-*")`, and that no new `supabase/functions/*loan*` folder is created.
- Update `src/test/architecture/employee-loan-lifecycle.test.ts` to pin: single set of lifecycle RPCs, canonical state machine, outbox emission per event, and idempotent JE `source_type` per event.

## Verification per phase

1. **L1**: enumerate every `employee_loan_lifecycle_*` RPC and confirm each calls `_loan_assert_transition`; unit test drives a loan through the full happy path and asserts illegal jumps raise `LOAN_STATE_INVALID`.
2. **L2**: from a Solo org with an admin as sole member, run `employee_loan_lifecycle_approve` + `employee_loan_authorize_disbursement` on a loan the same admin created — must succeed and produce `sod.self_action_auto_allowed` audit rows for both actions.
3. **L3**: authorize + disburse a test loan; assert a single balanced JE exists with correct debit/credit accounts, `source_type='loan_disbursement'`, and that a second call is a no-op (idempotent). Assert no edge function is invoked (network log).
4. **L4**: snapshot-test `getAvailableActions` for every status; drawer renders exactly the expected buttons per snapshot.
5. **L5**: after each lifecycle event, `business_event_outbox` has one matching row with the expected topic; notification subscriber consumes it and produces the same notices as today.
6. **L6**: `git grep 'loan-gl\|post-loan-'` returns nothing under `src/` and `supabase/functions/`; architecture test suite green.

## Out of scope for this consolidation

- Loan interest-accrual scheduling (monthly pg_cron) — will be re-introduced as a DB job in a follow-up once the posting RPCs are in place.
- Multi-currency loan disbursement — no live requirement in the current dataset; the posters accept a currency argument reserved for future use.
- Cross-app print/receipt rendering for disbursement advices — separate stream owned by the printing pipeline.
