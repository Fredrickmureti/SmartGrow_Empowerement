# Loan lifecycle workflow — sequencing, guards, errors, guided UX

Findings below come from reading the lending screens/hooks and the live database
(`_mf_application_guard`, `mf_create_loan_from_application`, `mf_disburse_loan`,
constraints and SoD triggers). No code changed yet.

## A. The real business-event sequence (as the database enforces it)

```text
Application created (draft, or submitted directly)
        ↓  submit — product eligibility rules bite here (cycles, age, group)
Submitted
        ↓  start review
Under review
        ↓  assessment recorded (at least one, physical visit)  ── required
Approved  (branch manager/admin only; not the person who submitted — SoD;
           approved amount + term required and inside the product-version band)
        ↓  CREATE LOAN  (mf_create_loan_from_application)
           = mints the loan, freezes product terms, generates the schedule,
             writes the loan_created event AND flips the application to
             "ready for disbursement" — one business event, several steps
Loan pending disbursement
        ↓  DISBURSE (mf_disburse_loan) — one-shot; realigns schedule to the
           value date, deducts configured fees, posts the ledger entry,
           activates the loan, sets the application to "disbursed"
Active loan → repayments (batch per group meeting) → banking → closure,
             or write-off / top-up / restructure / disbursement reversal
```

Key point: `ready_for_disbursement` is a **consequence of loan creation**, not a
step a human performs. The database allows the bare status flip, but nothing in
the business chain is served by it.

## B. Defects found

1. **"Mark ready" is a trap (the workflow defect).**
   The applications table shows a `Mark ready` button on approved applications.
   It only flips the status. But the Create-loan dialog lists *only*
   applications with status exactly `approved`. So an operator who clicks
   `Mark ready` after approval moves the application out of the only picker
   that can create its loan — the application becomes a dead end with no
   action anywhere in the UI, while `mf_create_loan_from_application` would in
   fact still accept it. This is the "action offered before/instead of its real
   prerequisite" class the wave is about.

2. **`[object Object]` toasts — root cause identified.**
   Every lending hook normalises errors with
   `error instanceof Error ? error.message : String(error)`. Supabase returns
   `PostgrestError` as a **plain object**, not an `Error`, so `String(...)`
   yields `[object Object]`. Every refusal raised by a guard trigger or RPC
   (`mf_loan_applications` updates, `mf_create_loan_from_application`,
   `mf_disburse_loan`, repayments, batches, banking, products) currently loses
   its business message this way. The project already owns a central
   normaliser (`normalizeError` in `src/services/resilience`) plus an ESLint
   rule against raw error text in toasts — the mf hooks bypass both.

3. **The `disbursed` application state is invisible to the UI.**
   The database allows and sets `status = 'disbursed'`; the frontend status
   list, labels and colour map do not contain it, so a disbursed application
   renders with an empty badge and cannot be filtered.

4. **No state/next-step guidance.** Both pages render bare action buttons per
   status flag. Nothing tells the operator what has already happened, what the
   next legitimate event is, or why disbursement is not yet possible (loan not
   created, or fees/accounting mapping unresolved).

5. **Prerequisites that exist only in the backend and are never surfaced:**
   assessment before decision, decision-maker ≠ submitter (SoD), approved
   amount/term inside the product band, published product version in force,
   accounting mapping resolvable for the disbursement method, fees not
   exceeding principal, loan exists before disbursement, no prior
   disbursement, `active` before repayment/closure/write-off.

Backend guards are sound; nothing needs weakening.

## C. Remediation

### Phase 1 — error truth (do first, it makes everything else diagnosable)
- Add one shared lending error mapper built on the existing `normalizeError`,
  which reads `message`/`details`/`hint`/`code` off Postgres/Postgrest objects
  and keeps the guard's business sentence (e.g. "An application cannot be
  decided before an assessment is recorded"), while suppressing SQL text,
  constraint names and stack detail.
- Route every `mf_*` hook's `onError` through it. Delete the four local
  `friendly()` copies. No second error architecture.

### Phase 2 — correct the sequence in the UI
- Remove `Mark ready` as an operator action; readiness is produced by loan
  creation.
- Approved applications get a single primary action: **Create loan**, opening
  the existing create-loan dialog pre-selected on that application.
- The create-loan picker accepts `approved` *and* `ready_for_disbursement`
  applications without a loan (matching the RPC), so existing stuck records
  recover.
- Add `disbursed` to the status list, labels and tone map; show the linked loan
  number on an application that has one.

### Phase 3 — guided workflow
- A workflow strip on each application row/detail: completed events (submitted
  → assessed → approved), current state, and one clear next step.
- On the loans page, state-aware actions: pending-disbursement loans lead with
  **Disburse**; lifecycle actions stay on active loans only. Where an action is
  legitimately visible but blocked, it is disabled with the reason stated
  ("Disbursement becomes available once the loan is created"), never silently.
- Keep all legitimate alternatives (reject, cancel, return to draft, reverse,
  top-up, restructure) exposed at the states the guard actually accepts.

### Phase 4 — tests
- Happy path: draft → submit → review → assess → approve → create loan →
  disburse → active.
- Premature actions rejected by the backend: approve without assessment,
  approve by the submitter, create loan twice, disburse a loan with no loan
  record/already disbursed, repay a pending loan, close an unsettled loan.
- Error rendering: a Postgrest-shaped plain error object must render its
  business sentence, never `[object Object]` and never raw SQL.
- Reload/stale-state: after refetch the available actions match the stored
  state; a stale button still gets refused by the backend.

## Technical notes
- No migration is expected. If the audit turns up a genuinely missing guard
  (rather than a UI mismatch), it goes in as its own small single-purpose
  migration.
- Files in scope: `src/hooks/useMf*.ts`, `src/apps/lending/applications/*`,
  `src/apps/lending/loans/*`, plus one new lending error mapper under
  `src/services/resilience` usage, and tests under `src/test/`.


========================================IMPLEMENTATION STATUS=========================

I've completed the first part of the work and stopped mid-way.

Done so far: every lending refusal now shows the real business reason instead of [object Object] — there's a single shared translator for loan errors, and all lending screens and data hooks go through it. The applications pipeline also now understands the "disbursed" stage, the misleading "Mark ready" shortcut has been removed from the state model, and the create-loan picker accepts any approved application that doesn't yet have a loan (so previously stranded applications can move forward again).

Still outstanding: the guided workflow display on the applications page (completed steps, current meaning, single clear next action, and explanations for unavailable actions), wiring the new "Create loan" action there, the same guidance on the loans page, and the workflow test matrix. Typechecking passed on everything changed so far.