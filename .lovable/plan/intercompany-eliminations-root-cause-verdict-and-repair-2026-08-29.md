# Intercompany eliminations — root cause verdict and repair

The previous engineer's note is wrong on the most important point, and its proposed
remedy would have fabricated an entry. Everything below was re-verified this session
against the live `AccrualFlowCorporation` database, not taken from the log.

## Verdict 1 — the KES 1,500 is not a missing Mombasa entry

Evidence, from the posted journals that the elimination engine actually consumes:

```
Joshua Holdings
  JH-IC-2026-001  30 Jun  Dr 1180 Intercompany receivable  2,630,000 / Cr 4180  2,630,000
  JE-00002        18 Aug  Dr 1100 Accounts Receivable             69.60   Invoice 00001
  JE-00004        18 Aug  Dr 1100 Accounts Receivable          1,670.40   Invoice 00002
  JE-00019        31 Aug  Cr 1180 FX revaluation                40,000
Mombasa Port Services
  MPS-IC-2026-001 30 Jun  Dr 5180  USD 20,000 / Cr 2180  USD 20,000
```

The 2,630,000 / USD 20,000 pair reconciles. The KES 1,500 comes only from invoices
00001 and 00002 — 1,500 net plus 240 VAT = 1,740 gross — and those invoices are
issued to the contact **Fredrick Mureti**, a natural person (`is_company = false`,
personal gmail address, Nairobi CBD address), a genuine third-party customer.

He is pulled into the intercompany population solely because a row in
`consolidation_intercompany_partners` (created 27 Aug) declares his contact record
to be the counterparty **Mombasa Port Services**. It is a mis-registered partner
mapping, not an unbooked liability. Mombasa "booked nothing against it" because
there is nothing to book: the sale was to a third party. Posting the previously
proposed Dr 5180 / Cr 2180 KES 1,500 in Mombasa's books would have invented a
liability that does not exist and overstated group expense.

A second, independent defect makes this worse: that mapping is effective from
2026-08-27, yet the invoices are dated 2026-08-18.
`consolidation_intercompany_entry_lines` tests the partner's effective window
against the *report window* (`effective_from <= _date_to`), never against the
*entry date*. Any partner relationship therefore retro-taints every entry to that
contact for the whole period — a real tenant that starts trading with a company
and later acquires it would have its pre-acquisition third-party sales silently
treated as intragroup.

## Verdict 2 — the KES 100 tolerance is intentional policy, not a hard-coded artifact

`_consolidation_validate_tolerance` (called from the rule guard, so it holds for
every write path, not just the UI) implements a deliberate control:

- the bound comes from `consolidation_tolerance_rounding_bound(currency)`, currency-
  scaled — KES two decimals gives 100;
- above the bound a tolerance is allowed, but only with a difference policy other
  than `refuse` and a written reason of at least 20 characters;
- percentage tolerances are treated the same way.

This is correct and matches mature practice: rounding absorption is automatic,
materiality acceptance requires a named destination and an accountable reason. No
change is warranted. The UI already reads the bound from the database rather than
hard-coding 100. Nothing here will be widened.

## Verdict 3 — the change-log constraint failure is a real, separate bug

`_consolidation_elimination_rule_guard` writes an audit row with
`entity = 'elimination_rule'`, but

```
consolidation_group_change_log_entity_check
  CHECK (entity = ANY (ARRAY['group','member','group_account','mapping','intercompany_partner']))
```

never admitted that value. So **every** tolerance / policy / difference-account
change on any elimination rule fails, for every tenant — not only the two paths
tried. The audit row itself is legitimate and correctly shaped (`group_id`,
`organization_id`, before/after JSON); `member_id` and `business_id` are nullable
and irrelevant to this entity. The fix is to admit the value, which strengthens the
audit trail rather than weakening a constraint.

## Repair order

**Step 1 — unblock the audit trail (migration).**
Extend the entity check to include `elimination_rule` and `elimination_rule_pair`,
and add a per-entity shape constraint so that a member-scoped row must carry
`member_id`/`business_id` while a group-scoped row must not. Prove that a rule edit
now persists together with its log row.

**Step 2 — fix intercompany partner identification (migration + guard).**
- A partner mapping may only name a contact that represents the counterparty
  company: enforce `is_company = true` and reject a contact whose commercial party
  is a natural person. Warn (not block) when the counterparty side has no
  reciprocal mapping, since one-sided registration is what produces phantom pairs.
- Scope legs by `je.entry_date BETWEEN effective_from AND coalesce(effective_to,…)`
  in `consolidation_intercompany_entry_lines` and in
  `consolidation_leg_faces_counterparty`, replacing the report-window overlap test.
- `consolidation_diagnose_eliminations` gains a cause `unverified_partner`: when one
  side's flow arrives through a mapping that is not reciprocated, or through a
  non-company contact, the engine says the *relationship* is in doubt and points at
  the mapping — it must never assert "the other company failed to book this".

**Step 3 — correct this tenant's data, not its numbers.**
Retire the Fredrick Mureti → Mombasa Port Services mapping (close it, with the
reason recorded in the change log). No journal entry is created, no tolerance is
widened, no reserve is used. Re-run the engine and show the trading class
reconciling to zero on its own.

**Step 4 — difference accounts: no new behaviour yet.**
Establish, don't implement: the schema already requires the difference account to be
an active *group* account of the same group, which is what Oracle FCCS / OneStream /
SAP GC do — differences land in a named group-chart account, never an operational
member account. G2900 "Other liabilities" is a poor choice for a trading residual
but is architecturally legal. Creating an account inline from the rule dialog is
deferred to its own brick; for now the dialog links to Consolidation Account Mapping.

**Step 5 — regression coverage and tenant-safety.**
- SQL tests: an elimination-rule edit writes a valid log row; a natural-person
  contact cannot be registered as a partner; an entry dated before
  `effective_from` is not treated as intercompany; a genuinely one-sided
  reciprocal pair still refuses; tolerance above the bound with `refuse` still
  refuses.
- A one-off integrity report listing every existing partner mapping that is
  non-reciprocal or points at a non-company contact, so no future tenant reaches
  the consolidated statements before the mapping is sound.
- Artifact checkpoint on the Eliminations report per the standing directive: data
  source, totals reconciliation, group identity, traceability, run-label
  truthfulness, and an actual generated PDF inspected.

## Technical notes

Two migrations (change-log constraint; partner integrity + engine date scoping +
diagnosis cause). One data correction through the partner surface. No change to
tolerance semantics, no fabricated journals, no constraint relaxations.
