# ADR 0031: AR/AP Contact-Integrity Triggers

## Status
Accepted — 2026-06-02

## Context
ADR-0029 and ADR-0030 made `customer_ledger_entries` / `vendor_ledger_entries`
read-only projections of the General Ledger filtered by AR/AP control
account. That architecture guarantees subledger ≡ GL **only if every GL
line on a control account carries a `contact_id`**. A control-account GL
line without `contact_id` would land in the GL totals but be invisible in
both the customer/vendor ledger and any partner-grouped report — silently
breaking reconciliation.

Audit of current data confirmed zero offending rows, so we can enforce the
invariant prospectively without a backfill.

## Decision
Two database triggers were added, both `SECURITY DEFINER`:

1. **`trg_enforce_contact_on_control_line`** on `journal_entry_lines`
   (`BEFORE INSERT OR UPDATE OF account_id, contact_id`). Looks up
   `accounts.system_role`; if it is `accounts_receivable` or
   `accounts_payable`, requires `contact_id IS NOT NULL`.
2. **`trg_enforce_contact_on_posting`** on `journal_entries`
   (`BEFORE UPDATE OF status`). When an entry transitions to `posted`,
   counts AR/AP control-account lines on that entry with
   `contact_id IS NULL` and rejects the transition if any exist. This
   catches drafts that were saved with NULL contacts before the line-level
   trigger existed (impossible going forward, but cheap insurance).

Both triggers raise `check_violation` with a human-readable message naming
the offending account or entry.

## Consequences

- Posting code that previously could (in principle) attach an AR/AP control
  account without a customer/vendor will now fail loudly. Any such call
  site is a bug — it was already producing reports that disagreed with the
  GL.
- Manual journals authored in the GL UI must select a contact whenever they
  touch an AR or AP control account. The UI should validate this client-side
  too for a better UX (future work).
- Importers / migrations writing directly to `journal_entry_lines` MUST set
  `contact_id` on AR/AP lines. The trigger fires on the import path.

## Out of scope (future work)
- Client-side validation in the manual-journal editor mirroring the trigger.
- A migration data-quality dashboard that surfaces any historical pre-trigger
  rows missing `contact_id` (none today; tracked here for future imports).
- A scheduled comparison of `control_account_tieout.drift` and the existing
  `get_control_account_reconciliation` RPC against zero, emitted to the
  finance Slack/email channel.
