# Lending Cleanup — Investigation Report (no changes made)

Everything below was read from the live database (schema, foreign keys, triggers, security policies, stored procedures) and the app source. Nothing was modified.

## Headline finding

The system **already has** a complete pre-financial lifecycle for lending, including delete operations, and both are already wired into the screens. Nothing is missing architecturally. The owner cannot delete the current applications because the rules are deliberately refusing — not because a button is absent.

## What is actually in the institution's data today

| Records | Count | Notes |
|---|---:|---|
| Loan products | 1 | status `retired` |
| Product versions | 2 | |
| Applications | 6 | 4 `ready_for_disbursement`, 2 `under_review` |
| Loans | 4 | all `pending_disbursement` |
| Disbursements / repayments / loan fees | 0 | no lending money has moved |
| Repayment schedules | 48 | belong to the 4 loans |
| Client admission fees | 10 (KES 5,000, all paid & posted) | client-level, not loan-level |
| Journal entries | 24 (10 admission fees, 13 manual, 1 expense) | none from lending |

So: no lending money has moved. The only posted money is client admission fees and manual/expense entries, none of which are tied to an application or loan.

## Why deletion is being refused (exact reason)

1. **The 2 `under_review` applications** — delete is allowed only for `draft`, withdrawn, or declined applications. Fix path: withdraw (with a reason) first, then delete. The withdraw action already exists in the app.
2. **The 4 `ready_for_disbursement` applications** — each has already produced a loan (LN-000001..4). The rule refuses outright: an application that produced a loan is lending history.
3. **The loan product** — refused because 6 applications and 4 loans reference it. Once those are gone and the product stays `retired`, deletion is allowed and it removes its versions with it.
4. **The 4 loans themselves** — there is *no* delete permission on loans at all for normal users. Loans can never be individually deleted through the app; only the controlled reset procedure can remove them.

## Financial vs pre-financial: the distinction exists

- **Pre-financial and safely removable:** draft/withdrawn/declined applications and their assessments (assessments cascade automatically), unused or retired products with no applications/loans, and their versions.
- **Financially committed / never physically deleted:** disbursements, repayments, fee collections, journal entries, event postings. Published product versions are also immutable and undeletable, so historical loans keep their frozen terms.
- **In between (this institution's case):** a loan at `pending_disbursement` carries no money yet, but the design still refuses individual deletion, because a loan number has been issued and reserved in the numbering sequence.

## Recommended lifecycle matrix

| Entity | State | Financial activity | Safe physical delete | Correct operation | Why |
|---|---|---|---|---|---|
| Application | Draft | No | Yes | DELETE (existing action) | Nothing depends on it; assessments cascade |
| Application | Under review / assessed | No | No (blocked) | WITHDRAW, then DELETE | Two-step, keeps a reason and audit trail |
| Application | Approved, no loan yet | No | No | WITHDRAW, then DELETE | Same rule as above |
| Application | Declined | No | Yes, admin + reason | DELETE (admin only) | Requires organisation admin and a written reason |
| Application | Produced a loan | Indirect | No | BLOCK — act on the loan | It is lending history |
| Loan | Pending disbursement | No | No individually | Controlled lending reset | No per-loan delete permission exists |
| Loan | Disbursed / repaying / repaid | Yes | Never | REVERSE / CLOSE / WRITE-OFF | Reversal procedures already exist |
| Product | Draft, unused | No | Yes | DELETE | No published version, no applications |
| Product | Published, never used | No | Yes after retiring | RETIRE, then DELETE | Publication must be retired first |
| Product | Used by applications or loans | History | No | RETIRE (keep versions) | Historical loans depend on frozen versions |
| Product version | Published | History | Never | New version instead | Immutable by design |
| Admission fees / journal entries | Paid, posted | Yes | Never | Reverse if wrong | Real posted money, unrelated to lending |

## "Start fresh" already exists as a business operation

There is a controlled, organisation-scoped lending cleanup procedure that deletes lending records in the correct dependency order — collections, repayments, fees, schedules, disbursements, loan events, loans, assessments, applications — with clients and loan products as separate opt-in switches, products removed only after everything referencing them is gone. It is restricted to organisation owners/admins (or platform admins), and there is already a settings screen that previews the counts before running it. Clients, staff, branches, chart of accounts, financial configuration and audit infrastructure are untouched by it.

This is the correct instrument for the owner's request. No new deletion mechanism, no new status, and no database change is needed.

## Audit

Every deletion path writes to the audit log before removing the row, capturing who, when, the entity, the action, the full previous record, and the reason where one is required. Withdrawals are logged the same way. Audit history is never deleted by these operations.

## Recommended way forward (for your approval, not yet implemented)

1. Confirm with the owner that the 4 pending loans, their 48 schedule rows, and all 6 applications are test data to be discarded.
2. Use the existing controlled lending cleanup from the settings screen: preview first, then run with the loan-products option on and the clients option off (or on, if the 10 admission-fee clients are also test data — note their KES 5,000 of posted fees would then need separate accounting treatment, since fee reversal is a financial action).
3. Nothing else. No migration, no new buttons, no policy changes.

## Open questions

- Are the 10 clients with paid admission fees (KES 5,000 posted) test data too? If yes, those fees need reversal by accounting rather than deletion.
- Should the single retired loan product be deleted, or kept as the institution's genuine offer?
