# Loan Product & Loan Application Deletion — Findings and Proposed Wave

## What the investigation found (verified against the live database and code)

### Loan applications
- Statuses actually allowed: `draft`, `submitted`, `under_review`, `approved`, `rejected`, `ready_for_disbursement`, `disbursed`, `cancelled`. Live data holds only `draft` and `rejected` (2 records).
- Deletion **already exists in the database**: the delete rule on applications permits removal only when the record is `draft` or `cancelled`, and only for a user whose access group grants the "delete" operation on applications.
- It is **not exposed anywhere in the interface**. The applications screen has a create dialog, an assessment dialog and an approve/decline dialog only — no row menu, no delete, no cancel.
- There is no cancel/withdraw operation in code, even though `cancelled` is a legal state. So a submitted application today can only be declined, never withdrawn.
- Nothing else in the database points at an application except: the assessment records (removed together with the application) and the loan created from it. Because the loan keeps a required pointer to its application, an application that became a loan can never be removed — the database refuses it.
- Application fees are **not** application-scoped: fee collections are recorded against a client/group, never against an application. So today no accounting event can be attached to an unapproved application; the accounting boundary starts at loan creation/disbursement.

### Loan products
- Products have a lifecycle already: `draft`, `active`, `retired` (all 3 live products are `active`). `retired` is the existing archive path and is not surfaced as an action.
- Commercial terms live in immutable published versions. A published version can never be removed — the database blocks it outright.
- Because removing a product would try to remove its versions, **any product that has ever published a version is already undeletable**. Only a product whose versions are all unpublished drafts can physically go.
- Applications and loans point at both the product and the exact version they were priced on, with a hard "refuse" rule — historical lending context can never be lost.

### Conclusion (the real rule)
1. Applications: removal is safe only while the record has produced nothing — i.e. it is still a draft (or was withdrawn) and no loan exists for it. Everything past that point must be declined, withdrawn or reversed, never removed.
2. Products: a never-published, never-referenced product may be removed. A product that has been offered must be **retired**, not removed.
3. No new accounting path, no touching of journal entries, no second reversal mechanism — none is needed, because no financial event can precede loan creation.

## Proposed work

### 1. Backend (authoritative, one small migration per object)
- `mf_delete_loan_application(p_id)` — verifies the record exists, is in scope (institution + branch + loan-officer scope), the caller holds the applications "delete" permission, status is `draft` or `cancelled`, and **no loan references it**; removes the application and its assessments; writes an audit entry. Clear business errors otherwise ("This application has become a loan and cannot be removed — decline or reverse the loan instead").
- `mf_withdraw_loan_application(p_id, p_reason)` — the missing lifecycle move to `cancelled` for a submitted/under-review application, recorded with reason and actor. Approved/disbursed applications are refused.
- `mf_delete_loan_product(p_id)` — verifies permission and scope, refuses when any published version, application or loan exists; otherwise removes the product and its draft versions.
- `mf_retire_loan_product(p_id)` — the archive action: sets status `retired` so the product stops being offered while all history keeps its pricing context.
- Also confirm how the lending permission checker maps the "delete" operation for applications and loan products, and wire that capability through the existing access-group framework — no new hard-coded roles.

### 2. Interface (follows existing conventions — a row menu, not a "Delete tab")
- Applications list: add the standard row kebab menu with Open / Assess / Decision alongside **Withdraw** (submitted, under review) and **Delete** (draft or withdrawn, no loan). Delete uses the existing confirm-delete dialog, worded with the application number and client, marked destructive and permission-gated. When deletion is not allowed the menu shows the permitted alternative (Withdraw, or nothing but Decline) instead of a dead button.
- Products list: row kebab menu with Edit / Versions plus **Retire** (any offered product) and **Delete** (only when never published and unreferenced). Retired products remain visible under the existing status filter.
- Buttons reflect the rule but never enforce it — every action calls the backend operation, which is the control.

### 3. Testing (production-safe)
- All scenario tests run inside a transaction that is rolled back, using fixtures created in the test itself (prefix `ZZTEST-LOANDELETE`). No existing client, application, product, fee or journal entry is read-modified or removed.
- Matrix: unused product; product referenced by an application; product with a published version; product used by a loan; draft application; withdrawn application; submitted application; approved application; application converted to a loan; disbursed loan. Each asserts allowed/refused plus the exact message.
- Each prohibited case is also attempted directly against the backend operation, proving the interface cannot be bypassed.
- Record the results and the final rule in the project status file.

### 4. Explicitly out of scope
No changes to pricing, schedules, approval architecture, disbursement, repayments or the accounting posting layer. Anything questionable found on the way is reported as a separate classified finding.


=============IMPLEMENTATION PROGRESS AND WHERE THINGS STAND================


I stopped mid-way because credits ran out. Here's the state.

Done (backend, verified against your database):

Loan applications can now be withdrawn with a recorded reason, actor and timestamp — refused if the application already produced a loan, or is already rejected/disbursed/withdrawn.
Loan applications can now be deleted only while they are a draft or withdrawn and have never produced a loan; the full record is written to the audit trail before removal.
Loan products can now be retired (stop being offered, past lending keeps its pricing) and deleted only when never priced, never applied for and never lent on — each with an audit entry.
The underlying database rules were tightened so these limits hold even if someone calls the database directly, not just through the app.
Three new optional fields on applications record the withdrawal (when, who, why).
Not done:

The screens are unchanged — the new Withdraw / Delete / Retire actions are not yet visible on the Applications and Loan products lists.
The rollback-based test matrix has not been run, so the new rules are enforced but untested end to end, and no results were recorded in the project status file.
Continuing this needs available credits; when they're topped up I can add the row menus and run the test matrix next.