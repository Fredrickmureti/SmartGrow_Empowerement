# Loan product & application deletion — closing the two gaps

## Verification of the previous wave (checked just now)

Confirmed in the live database and in the code:

- The four operations exist and enforce the rules server-side: delete application, withdraw application, delete loan product, retire loan product.
- The Withdraw / Delete / Retire actions are already on the Applications and Loan products lists, permission-gated, with confirmation dialogs.

So the earlier report is accurate. What it did not cover is the two situations you hit.

## Gap 1 — a retired product you can never remove

Your V1PROD "V1 Proof Product" is retired, has no applications and no loans — but it has one *published price version*. Both the screen and the database refuse deletion purely because a price version was once published, even though nothing in the institution's history ever used it.

That is too strict. A published price only matters if something was priced on it. The correct rule:

> A loan product may be removed when no application and no loan reference it. If it was ever published, it must be retired first — so removal is a deliberate two-step act, not a slip.

A product touched by any application or loan stays undeletable and can only be retired. That is unchanged.

## Gap 2 — declined applications stay forever

Today only draft and withdrawn applications can be removed; a declined one is permanently on record. You are right that a declined test application should be removable, but it is a stronger act than deleting a draft, so it gets stronger controls:

- Only an administrator/owner may remove a declined application (ordinary delete permission is not enough).
- It requires a written reason.
- The confirmation is two-step: type the application number, then confirm.
- Still refused outright if the application ever produced a loan.

Draft and withdrawn applications keep today's single-step behaviour.

## Work

### Database (one small migration per object, as always)

1. Teach the price-version freeze rule to allow removal only inside the product-removal operation (a dedicated internal marker, not the reset switch).
2. `mf_delete_loan_product` — drop the "published pricing" refusal; instead refuse when the product is not retired while having published pricing. Keep the application/loan refusals, the permission check, the audit entry.
3. `mf_delete_loan_application` — add a declined path: allowed only for an organisation administrator/owner, requires a non-empty reason, refused when a loan exists. Reason recorded in the audit entry. Draft/withdrawn path unchanged.

### Interface

- Products list: Delete is offered for any product with no applications and no loans; when it has published pricing and is still active, the menu says "Retire it first, then it can be deleted". The confirmation names the product and states that no lending history depends on it.
- Applications list: declined rows show "Delete (administrator)" for admins only, opening a two-step dialog — reason box plus typing the application number — worded as permanent removal of a record kept for audit. Non-admins keep seeing "Declined applications stay on record".
- Buttons remain hints; the database stays the control.

### Verification

- Re-run the scenario checks inside a rolled-back transaction with self-created fixtures only: retired unreferenced product with published pricing (now removable), active published product (refused — retire first), product with an application (refused), product with a loan (refused), declined application as admin with reason (removed), as non-admin (refused), without reason (refused), declined application that produced a loan (refused).
- No production client, group, application, product or journal entry is created, changed or removed.
- Then remove V1PROD for real, since it qualifies under the new rule, and report the result.
- Update the status file with the final rule.


=============IMPLEMENTATION PROGRESS AND WHERE THINGS STAND================

Complete.

- Database: a retired product with no application and no loan can be deleted even if it was once published; an active published product is refused with "retire it first". A declined application can be deleted only by an organisation administrator, only with a written reason, and only if it never became a loan. Both write an audit entry.
- Applications list: declined rows now show "Delete (administrator)…" for owners/admins, opening the two-step dialog (reason + typing the application number). Everyone else still sees "Declined applications stay on record".
- Products list: the delete confirmation now reads "No application and no loan uses it", replacing the inaccurate "never been priced" wording.
- Typecheck passes.

Checked live: V1PROD (retired, 1 published version, 0 applications, 0 loans) now qualifies for deletion; LP-0001 (1 application) and LP-0002 (active, published) remain protected. V1PROD was left in place to be removed through the screen as the signed-in owner, which also proves the path end to end.
