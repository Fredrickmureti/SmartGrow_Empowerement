# Lending Lifecycle — Verified Investigation, Testing and User Guide

Goal: produce a client-ready Lending user guide that describes the system as it
actually behaves, plus an internal verification report. Discovery and testing
come first; writing comes last.

## What exists today (confirmed by directory read, not yet by behaviour)

The Lending app already has screens for products (with versions), clients,
groups, meetings, applications (form, assessment, decision), loans (create,
disburse, schedule, lifecycle), repayments (record, group sheet, bank batch),
collections, branch day and seven reports. Each has a matching data hook.
Whether each control behaves as its label suggests is exactly what this wave
must verify — nothing below assumes it.

## Wave 1 — UI walkthrough (source of truth for the guide's structure)

Drive the running app as a user, screen by screen, in lifecycle order:
products → product version → client → group/meeting (if required to borrow) →
application → submit → assess → decide → create loan → disburse → schedule →
repayment → closure. For every screen capture: navigation path, buttons,
every field with its exact label, input type, required/optional, default,
every dropdown option, and validation messages. Screenshots kept for reference.

Output: a raw walkthrough log (internal).

## Wave 2 — Trace each control to its real effect

For every field and option recorded in Wave 1, follow it from the form into the
hook, into the server routine, into the stored row. Establish for each:
what is stored, what is merely a default, what is a constraint, what is
recalculated later, what is ignored. Special attention to:

- Product → application inheritance: copied value vs default vs range
  constraint vs override; whether the application snapshots product terms and
  whether editing a product later touches existing applications/loans.
- Interest method options: what each one actually computes in schedule
  generation, not what the name implies.
- Fees, penalties, grace periods: when they are charged, when they hit the
  ledger.
- Status transitions: the real state machine and who may trigger each move.

## Wave 3 — Controlled behavioural tests (production-safe)

Real client and accounting data is read-only. Tests use a temporary isolated
test client/group/product created for this wave and removed or left clearly
marked afterwards; no real application, loan, meeting or journal entry is
touched.

Scenarios to run end to end and observe the resulting rows and journal effects:

1. Product with each available interest method → application → approval →
   loan creation → schedule. Compare schedules across methods.
2. Disbursement with and without deductible fees — confirm gross vs net cash.
3. Normal repayment, partial repayment, overpayment, final repayment/closure.
4. Penalty on a late instalment, if the system charges one.
5. Rejection path and cancellation path.
6. A reversal, where reversal is supported.

Each scenario records: what was entered, what the system produced, and the
accounting effect in business terms (which account is debited/credited).

## Wave 4 — Defect handling

Findings are classified as confirmed defect, potential design issue,
UX/documentation issue, or expected behaviour. Confirmed defects inside this
lifecycle are root-caused, fixed and retested in this wave, each recorded
separately. Questionable-but-deliberate business behaviour is flagged, not
redesigned.

## Wave 5 — Completeness reconciliation

Walk the Wave 1 log against the drafted guide outline and confirm every
navigation step, action, required field, meaningful optional field, dropdown,
calculation method, validation and status transition is represented, with no
unexplained jump between states.

## Wave 6 — Write the two deliverables

**Deliverable 1 — `docs/manuals/lending/user-guide.md`** (client-facing, no
technical vocabulary), following the requested structure: lifecycle at a
glance, before you start, create a product (field table + interest method table
with worked examples + repayment option table), create an application (field
table incl. relationship to product), submit and review, approve/reject,
create/activate the loan, disburse (field table), understand the schedule,
record repayments, the loan after disbursement, accounting overview in business
language, common scenarios, important rules, items requiring attention.

**Deliverable 2 — `.lovable/plan/lending-lifecycle-verification-<date>.md>`**
(internal): discovered lifecycle, screen → logic → data mapping, status
transitions, accounting events, tests run and their results, defects found,
fixes made, design issues, remaining uncertainties.

## Ground rules

- Every statement in the guide traces to observed UI behaviour, traced logic,
  or a recorded test result. Nothing inferred from a field name.
- No production client, application, loan, meeting, fee transaction, journal
  entry or accounting period is modified.
- Fixes are limited to defects proven by a test in this lifecycle.

## Scale note

This is a large wave: roughly twenty screens to walk, several dozen fields to
trace, and six test scenarios to run before any writing starts. It will run
across multiple steps, with progress reported as each wave closes.
