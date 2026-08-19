# Why the match sheet looks empty — and what to change

## What the screenshots actually show

The badge says **Awaiting review** and the reason line says *"This line already has a proposed match awaiting confirmation."* That is not a missing suggestion engine — it is the engine deliberately refusing to speculate. `bank_match_candidates` returns zero candidates and that tier whenever the line already carries an open match row, so nothing renders.

At the time of the screenshot the Fredrick Mureti line was blocked by a stranded proposal (an `account`-kind row left behind by an earlier failed confirm). That row is now `rejected`, and I re-checked the line against the database: the receipt for KES 1,670.40 is `applied`, sits in **Undeposited Funds**, same date, same branch, same business, and the bank line is still unreconciled — so the engine's own conditions for the *"Deposit the recorded receipt from Fredrick Mureti"* candidate are all satisfied. Re-opening the sheet should now show it. That is the first thing to confirm.

Two real defects remain, both visible in the screenshots.

## Defect 1 — "Awaiting review" is a dead end

When a line already has an open proposal, the sheet says so and then offers no way to act on it. There is no Confirm, no Reject, no view of what was proposed. The only remaining route is the manual tabs — which is exactly how an operator ends up hand-matching a line that already had a correct answer waiting. The stranded proposal blocked this line invisibly for that reason.

**Change:** when the tier is `proposed`, show the existing match (its kind, party, amount, allocations) with **Confirm** and **Reject** actions wired to the existing `bank_match_confirm` / `bank_match_reject` seams using `existing_match_id`. When the tier is `settled`, say so and offer nothing but a link to the confirmed match. No new backend seam.

## Defect 2 — the manual tabs are unconstrained, and offer no clearing path

The Invoices tab lists **every** open invoice: invoice 00001 for KES 69.60 appears under a KES 1,670.40 deposit, with no amount, party or currency filter. The user's instinct is right that this invites a wrong match. It would not corrupt the ledger — `_bank_match_validate` enforces an amount law (allocations must equal the bank line adjusted for a named bank charge) and refuses the 69.60 outright — but the refusal only arrives after Reconcile is pressed, as a raw error. The picker should not offer what the seam will reject.

The deeper gap: **clearing is not reachable by hand at all.** The four tabs are Invoices / Bills / Expenses / Journal. Recognising an already-recorded receipt exists only as an engine suggestion; if the suggestion is suppressed (as it was here), the operator's only option is to re-settle the invoice or hand-post a journal.

**Changes:**
- Add a **Recorded payments** tab (money-in: customer receipts not yet deposited; money-out: supplier payments not yet cleared), sourced from the same candidate payload shape so a hand-picked clearing and an accepted suggestion travel the same road.
- In the Invoices/Bills tabs, show each document's outstanding amount against the bank line, mark exact matches, and disable rows that cannot balance the line on their own (unless combined selection reaches it) with a short reason — "does not equal this bank line", "different currency".
- Default the sheet's active tab to Recorded payments when a clearing candidate exists, so recognising money already recorded is the first offer, never the last.

## Defect 3 — the Journal tab lets an operator hand-post around the clearing seam

Today an operator who cannot find the suggestion searches for **Undeposited Funds** in the Journal tab and posts Dr Bank / Cr Undeposited Funds by hand. The GL nets out correctly, which is why it feels right — but the payment itself is never linked to the bank line, so nothing marks that receipt as deposited and the *same* receipt can be offered and deposited again on another statement line.

**Change:** when a clearing candidate exists for this line, the Journal tab warns and points at it rather than silently accepting a hand-post; and choosing a clearing/holding account (Undeposited Funds and peers) in the Journal tab is blocked with the reason that a recorded receipt must be cleared through the payment path, not re-posted.

## Technical notes

- Frontend-only: `src/features/finance/reconciliation/ReconcileTransactionSheet.tsx` plus a small hook for the recorded-payments picker; the existing `useBankMatchCandidates` payload already carries `existing_match_id`, `kind`, `effect` and `evidence`.
- No change to `bank_match_candidates`, `_bank_match_validate`, `bank_match_confirm` or `bank_match_reject` — the accounting rules are correct as written (ADR-0144, ADR-0147); the sheet simply does not expose them.
- Step 0 is verification: re-open the sheet on the Fredrick Mureti line and confirm the "Deposit the recorded receipt" candidate now appears. If it does not, that becomes the first fix and the sheet work follows it.
