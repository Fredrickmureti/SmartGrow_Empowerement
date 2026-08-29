# Intercompany partner integrity — 2026-08-29 (executed, verified)

## What the KES 1,500 actually was

Not an exchange difference, not a missing Mombasa entry, and not a tolerance
problem. `consolidation_intercompany_partners` carried a declaration saying the
contact **Fredrick Mureti** — `contacts.is_company = false`, a private Gmail
address, a Nairobi street address — stood for **Mombasa Port Services** in
Joshua Holdings' books, effective 2026-08-27.

Two ordinary sales invoices to that person (`JE-00002`, `JE-00004`, both
2026-08-18, KES 1,500 net + KES 240 VAT) were therefore read as intra-group
trade. Mombasa had booked nothing against them because there was nothing to
book: the sales are third-party revenue.

Widening tolerance to 1,500, routing it to the translation reserve or to
G2900, or posting a balancing journal in Mombasa would each have recorded a
falsehood. None was done.

## What changed (migration, this session)

1. **`_consolidation_partner_guard`** now refuses a declaration whose contact is
   not a company, naming the contact and saying why.
2. **`consolidation_leg_faces_counterparty`** takes the *entry's* date instead of
   the report window. A declaration beginning 27 August no longer reaches an
   invoice raised on 18 August. The old `(…, date, date)` signature is dropped.
3. **`consolidation_intercompany_entry_lines`** selects entries by
   `entry_date BETWEEN effective_from AND effective_to`, and applies its
   "account not in the consolidated trial balance" refusal only to the legs the
   engine actually consumes.
4. **`consolidation_partner_integrity_report(group)`** lists declarations that
   cannot support an elimination: an individual contact, or a relationship the
   other company has never declared back.
5. **`consolidation_diagnose_eliminations`** splits the old `one_sided_flow`
   verdict into three: `non_company_partner`, `unverified_partner` (no
   reciprocal declaration), and the original `one_sided_flow` only when both
   companies have declared each other. A one-sided gap no longer blames the
   silent company for a relationship that was never real.

Earlier in the same repair: `consolidation_group_change_log_entity_check` now
admits `elimination_rule` and `elimination_rule_pair`, so elimination-policy
edits persist with their audit row instead of failing on the constraint. A
shape check keeps member rows carrying `member_id` and mapping/partner rows
carrying `business_id`.

## Tenant data correction

The Fredrick Mureti declaration was deleted (id `12cf0369…`). The delete is
recorded by `_consolidation_partner_log`. No journal entry was created,
amended or reversed.

## Verified by execution

Intercompany-scoped posted entries for the group, after the change:

| entry | date | company |
|---|---|---|
| JH-IC-2026-001 | 2026-06-30 | Joshua Holdings |
| MPS-IC-2026-001 | 2026-06-30 | Mombasa Port Services |
| JE-00019 | 2026-08-31 | Joshua Holdings (retranslation of the intercompany receivable; its FX loss leg is correctly excluded) |

`JE-00002` and `JE-00004` — the KES 1,500 — no longer appear. Tolerance stays
at the database-governed KES 100 rounding bound with `refuse`; nothing was
relaxed.

## Not done yet

- Screen/PDF artifact checkpoint for the eliminations report.
- R5 (member-level revaluation policy), R6 (reserve articulation), R7 (revoking
  `anon` EXECUTE on the run-lifecycle RPCs and driving a real run).
