# Admission fee: individual liability, group collection

## What exists today (verified in code)

- `mf_client_fee_policy` — one row per institution: amount, currency, active flag. Nothing hardcoded.
- `mf_client_charges` — one obligation per client per kind (`admission_fee`), unique index prevents a second live charge. Status is `outstanding | paid | reversed`, and the row itself carries `receipt_number`, `paid_on`, `method`, `reference`, `journal_entry_id`.
- `mf_raise_client_admission_fee` (creates the obligation from policy), `mf_pay_client_charge` (all-or-nothing settlement: numbers a receipt, posts cash debit / fee income credit through `mf_resolve_account` + `post_journal_entry_atomic`), `mf_reverse_client_charge` (voids the entry via `void_journal_entry_atomic`, marks the charge reversed).
- Permissions everywhere through `mf_can(business, branch, module, action)`: reading uses `clients/read`, money uses `repayments/create` and `repayments/write`.
- Group-collection precedent already exists for loans: `mf_repayment_batches` (one per meeting) with per-client receipts and server-written allocations.
- The receipt already renders through the existing document snapshot engine (`src/services/documents/snapshots/lending.ts`).

Two real gaps: settlement is all-or-nothing (no partial), and there is no collection container, so five members require five separate cash transactions.

## Business interpretation (researched, not assumed)

In ASA-style group lending the admission/registration fee is an **individual** obligation of the member, raised once when the client is admitted to the institution — not per loan, not per group, and never charged again when the member joins a second group. The group meeting is only the **place where cash is handed over**. Group liability is not created, and the group is never the accounting subject. This matches the memory rule already recorded for this institution (individual liability in a group setting, no joint liability).

Consequences that follow from that, and which the design enforces:

- The obligation stays on `mf_client_charges`. No group fee table, no invoice.
- A collective hand-over is one cash receipt with per-member allocations, exactly like the existing loan repayment batch.
- Partial collection is normal: the operator states who is being settled and for how much; the system never silently spreads money.
- Membership and fee are separate: adding a member never moves money and never blocks on an unpaid fee.
- Changing the configured amount affects obligations raised afterwards only; existing rows are frozen at their raised amount.

## Chosen architecture

Additive. The individual flow keeps working unchanged.

```text
mf_fee_collections (group, date, collector, total, method, reference)
  └── mf_client_charge_payments (charge_id, amount)   -- also used by individual payments
        └── mf_client_charges (the client's obligation)
```

### Schema changes (one migration per object group)

1. `mf_client_charge_payments` — the settlement ledger: `charge_id`, `collection_id` (nullable for individual payments), `business_id`, `branch_id`, `client_id`, `amount > 0`, `paid_on`, `method`, `reference`, `receipt_number`, `status ('posted'|'reversed')`, `journal_entry_id`, reversal columns, `created_by`. Grants, RLS via `mf_can` (read `clients/read`, insert `repayments/create`, update `repayments/write`), touch trigger.
2. `mf_client_charges` gains `paid_amount numeric(18,2) NOT NULL DEFAULT 0`, maintained **only** by a trigger over `mf_client_charge_payments`; `status` becomes derived: `paid_amount = 0 → outstanding`, `0 < paid_amount < amount → part_paid`, `= amount → paid`, plus `reversed`. Existing paid rows are backfilled into one payment row each so no history is lost and the existing receipt keeps resolving.
3. `mf_fee_collections` — collection header: `business_id`, `branch_id`, `group_id`, `collection_number`, `collected_on`, `collected_by`, `total_amount`, `method`, `reference`, `status`, `journal_entry_id`, reversal columns, `client_request_id` with a partial unique index on `(business_id, client_request_id)` for retry safety.
4. View `mf_client_fee_positions` — client, group, amount, paid, outstanding, last collection. Single read model for screens and reports.

### Server routines

- `mf_collect_group_admission_fees(p_group_id, p_collected_on, p_method, p_reference, p_notes, p_lines jsonb, p_client_request_id)` where each line is `{client_id, amount}`. It: authorises via `mf_can(... 'repayments','create')`; locks each charge `FOR UPDATE`; rejects a client appearing twice, an amount above that client's outstanding, a client not in the group, and a non-live charge; requires `sum(lines) = total`; raises the obligation from policy first if a member has none yet (so a new member can be collected in the same run); numbers the collection and one receipt per allocation; posts **one** journal entry — a single cash/bank/mobile-money debit for the total against `fee_income`, with one credit-side description per member — through `mf_resolve_account` + `post_journal_entry_atomic`; returns the collection id. Replays return the existing collection on a repeated `client_request_id`.
- `mf_reverse_fee_collection(p_collection_id, p_reason, p_effective_on)` — `repayments/write`; voids the collection entry with `void_journal_entry_atomic`, marks every payment row reversed (which restores each client's outstanding through the trigger), keeps the original rows. Nothing is deleted.
- `mf_pay_client_charge` is rewritten to insert a payment row (partial amount now allowed, defaulting to the full outstanding) and keep posting its own single-client entry, so the current individual dialog behaves identically.
- `mf_reverse_client_charge` keeps working, delegating to payment-row reversal.

### Screens

- **Client record** — unchanged dialog, now showing paid/outstanding split and, where the settlement came from a group collection, the collection reference.
- **Group → Collect admission fees** (new dialog on the groups page): lists every member with fee due, paid, outstanding; include tick plus editable amount defaulting to the full outstanding; live total; submit disabled unless the entered lines sum to the stated total. Members with nothing outstanding are shown as settled and cannot be ticked.
- **Add member to group** — shows "this client has an outstanding admission fee of X" as information only, with a link into the collection workflow. Adding a member never posts money.
- **Collection history** on the group, with the reverse action gated on `repayments/write`.
- Receipt: extend the existing lending snapshot with a group-collection receipt listing group, reference, date, collector, total, and each member with amount allocated and amount still outstanding. No new renderer.

### Permissions

Existing groups only. View fee status → `clients/read`. Individual payment and group collection → `repayments/create`. Reverse → `repayments/write`. Fee configuration → `accounting/write`. All enforced inside the SECURITY DEFINER routines and in RLS, not in the browser.

## Tests (run against this database, then reported here)

Realistic group with five members: 1 individual payment, 2 collective collection of the unpaid members, 3 mixed state, 4 partial collection, 5 new member added then included in the next collection, 6 duplicate attempts (same client twice, resubmitted request key, already settled), 7 reversal restoring each outstanding balance, 8 re-collection after reversal. After each: charge status, client outstanding, group outstanding, collection + allocation rows, journal balance and mapped accounts, receipt, audit trail. Then typecheck and a browser pass over the client and group screens.

## Continuation point

Nothing implemented yet. Order: migration 1 (payments table) → 2 (charges paid_amount + status + backfill) → 3 (collections header) → 4 (view) → routines → hooks → group dialog + membership notice → receipt snapshot → tests → results appended here.


====================IMPLEMENTATION STATUS/PROGRESS===========
I've built the foundation of the individual-liability / group-collection fee model in the database, but the work is not finished.

In place now

The fee stays the individual client's obligation. A new settlement ledger records every payment against a client's fee, so a fee can now be partly paid, and each client's paid/outstanding amount is maintained automatically from real payment records — never a hand-set "paid" flag.
A group collection record exists: one cash hand-over at a group meeting, with a retry key so a double-click or network retry can't take the money twice.
Individual payment still works exactly as before (it now also accepts a part amount).
Reversals restore each client's outstanding balance instead of deleting anything; a payment taken in a group collection must be reversed through that collection so the single cash entry stays intact.
A single read view answers "who owes, who paid, how much remains, and which collection settled them" for both client and group questions.
Existing settled fees were migrated into the new settlement records, so no receipt or history was lost.
Still to do (exact continuation point)

The group collection routine itself (mf_collect_group_admission_fees): validate the selected members and amounts against each client's real outstanding, raise a missing obligation for a new member, number the collection and one receipt per member, and post one journal entry for the total.
The matching reversal routine for a whole collection.
The app side: read hooks, the "Collect admission fees" screen on the group (members, due/paid/outstanding, tick + amount, live total), an information-only outstanding-fee notice when adding a member, collection history with reverse, and the group receipt listing each member and their allocation.
The eight test scenarios end to end against the real records, then a typecheck.
Nothing in the individual flow was broken by these changes, and the plan file archived at .lovable/plan/admission-fee-individual-liability-group-collection-2026-09-09.md holds the full reasoning and this continuation list.