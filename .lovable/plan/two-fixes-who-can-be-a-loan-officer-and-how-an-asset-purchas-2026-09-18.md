# Two fixes: who can be a loan officer, and how an asset purchase is paid

Both concerns were checked against the live system before writing this plan.

## 1. Admins don't appear in the loan officer list

**What I found (verified).** The list is not filtered by job title at all — it is
filtered by branch assignment. Only people who have a row in the branch
assignment table are offered. In your live data:

| Person | Role | Branches assigned |
| --- | --- | --- |
| Fredrick Mureti | owner | 1 |
| Rose Mwende | loan officer | 1 |
| William Mutisya | admin | 0 |
| Kwali | admin | 0 |
| Mercyline Nduku | admin | 0 |

The three admins have no branch assignment, so they are invisible in the picker.
Being named the loan officer of a group does not create a branch assignment, which
is why "I provisioned myself" did not help.

There is a second, deeper reason: the registration routine in the database also
refuses a loan officer who is not assigned to the client's branch. So simply
listing everybody in the form would produce a refusal on save. Both layers must
change together.

**The fix.**

- The picker lists every active internal team member, regardless of role, with a
  quiet note next to anyone not yet attached to the chosen branch.
- Owners and admins are accepted as loan officers for any branch of the
  institution — their role already gives them authority over all branches.
- A non-admin team member still has to be assigned to the branch; the existing
  sentence ("This loan officer is not assigned to the selected branch.") stays for
  that case only.
- The same picker is used when registering a client, when creating or editing a
  group, and on the loan application form, so all three benefit.

Nothing about existing clients, groups or their officers changes.

## 2. A new fixed asset always says it was paid from the bank

**What I found (verified).** Your instinct is right — this is a defect, not a
design choice. The asset screen sends the payment method as the fixed word
"bank", and the database routine credits the mapped bank account. The form never
asks. So an asset bought in cash, by M-Pesa, or on credit from a supplier still
shows money leaving the bank, and your bank reconciliation will never find that
withdrawal. Auditors would be right to query it.

**What accounting expects.** The purchase debits the asset; the credit must be
whatever actually settled it:

- paid from a bank account → credit that bank account;
- paid in cash → credit cash;
- paid by mobile money → credit the mobile money account;
- not paid yet, invoiced by a supplier → credit Accounts Payable, and the later
  payment clears it. This is the most common case in practice and the one your
  system cannot express today.

The date is a separate matter: the acquisition posts on the purchase date you
type, so a future date puts a future-dated entry in the ledger. That is normally
not wanted, so the form will flag a purchase date in the future instead of
silently posting it.

**The fix.**

- The asset form gains a required "How was this paid for?" choice: a specific bank
  account, cash, mobile money, or "Not paid yet — owed to the supplier".
- Choosing "owed to the supplier" requires a supplier to be named and credits
  Accounts Payable, leaving a normal payable to settle later.
- A future purchase date is refused with a plain sentence.
- Existing assets and their posted entries are untouched. Nothing is
  recalculated or reversed. If you want the already-posted asset corrected, that
  is a separate, deliberate correction we can do after this.

## Technical notes

- `mf_register_client` (both overloads): accept the officer when they are assigned
  to the branch **or** hold owner/admin in the organisation, via the existing
  `has_role` helper. No other logic touched.
- `useBranchOfficers`: return all active internal members of the institution,
  keeping `branchIds` so the form can mark who is unassigned; add a flag for
  organisation-wide authority. Callers keep their current shape.
- `fa_create_asset`: extend the settlement resolution to accept `accounts_payable`
  alongside the existing `bank`/`cash`/`mobile_money` keys, require a vendor for
  the payable case, and reject a purchase date after today. The default stays
  `bank` for backward compatibility but the UI always sends an explicit value.
- `useFixedAssets`: stop hardcoding `_payment_method: "bank"`; pass the chosen
  method through from `AssetFormBody` / `AssetCreatePage`.
- No data migration, no recalculation, no destructive SQL.

## Verification

- Register a client choosing an admin as loan officer — it saves.
- Register a client choosing an unassigned non-admin — the existing refusal shows.
- Create an asset paid in cash and one owed to a supplier; open each journal entry
  and confirm the credit is cash and Accounts Payable respectively, and that the
  bank is untouched.
- Attempt a future purchase date and confirm it is refused.
- Confirm existing assets, clients and groups are unchanged.
