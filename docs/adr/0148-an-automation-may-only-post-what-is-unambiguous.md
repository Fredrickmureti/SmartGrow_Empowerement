# ADR 0148 — An automation may only post what is unambiguous

Status: Accepted
Date: 2026-08-19
Related: ADR-0143 (a bank feed is transport), ADR-0144 (bank reconciliation is
one matching seam), ADR-0147 (a bank line is explained, not guessed)

## Context

ADR-0147 gave a bank line an explanation carrying its evidence. It said nothing
about the second and third time that explanation is asked for — which is exactly
what a feed does. A feed re-polls, an operator re-imports last month's
statement, a rules run sweeps the same account twice a day. Five defects lived
in that repetition.

1. **A settled line was still a question.** `bank_match_candidates` never looked
   at the line's own match, so a reconciled deposit still came back with a
   "certain" suggestion to settle the invoice again. Ingest deduplicates the
   line (fingerprint + `ON CONFLICT DO NOTHING`), but nothing deduplicated the
   *explanation*.
2. **A proposed line was re-proposed.** A line awaiting a human decision
   received a fresh candidate set, and the rules run happily added a second
   proposal on top of the first.
3. **A document could be spoken for twice.** Only *confirmed* matches removed a
   document from the candidate pool, so two bank lines could each hold an open
   proposal against the same invoice, receipt or mirror transfer line.
4. **Ambiguity cancelled itself out.** The multi-receipt deposit query
   aggregated every valid combination into a single row and then demanded
   exactly two members, so *one* possibility produced a candidate and *two*
   produced silence — the ambiguous case disappeared instead of surfacing.
5. **A rule race was resolved by creation order.** Two active rules of equal
   priority matching the same line: the runner took the first and, if the rule
   said `auto_post`, posted it.

## Decision

1. **An explained line is an answer, not a question.** When a line is
   reconciled or carries a proposed match, the evidence engine returns zero
   candidates and a tier that names the state (`settled` / `proposed`) plus the
   match that explains it. Replay is therefore inert by construction, not by
   luck.
2. **A reservation begins at the proposal.** A document is spoken for by a
   *proposed or confirmed* match, and the question is asked in exactly one
   place (`_bank_doc_is_spoken_for`) so every candidate class asks it the same
   way. Mirror transfer lines are reserved on the same terms.
3. **Ambiguity is surfaced, never averaged or swallowed.** Every valid
   combination is its own candidate, so N possibilities tie at the top score
   and the line reads `ambiguous`. A tier is still derived from evidence, never
   asserted by a caller.
4. **An automation posts only what is unambiguous.** A rules run skips lines
   that already have a match, refuses when two equally-ranked rules claim a
   line (`AMBIGUOUS_RULE_MATCH`), and degrades an ambiguous or already-explained
   line to a proposal a human sees. It proposes through the seam and posts
   nothing itself.
5. **Idempotence is a property of the schema, not of a writer's manners.** The
   statement movement's identity is a unique index on
   `(bank_account_id, external_transaction_id)`; ingest reports duplicates
   rather than minting a second line.

## Consequences

- Re-importing a statement, or re-running a feed, changes nothing that was
  already explained.
- Two operators working two bank lines cannot both propose the same invoice.
- "Ambiguous" is visible in the workspace instead of being an empty panel.
- An unattended rules sweep can only ever leave proposals behind when it is not
  certain — the failure mode is a queue, never a wrong posting.

## Enforcement

- `supabase/tests/bank_match_automation_invariants_test.sql`
- `supabase/tests/bank_match_resolution_invariants_test.sql`
- `supabase/tests/banking_privilege_ratchet_test.sql`
- `_bank_doc_is_spoken_for` is internal: no `anon` and no `authenticated`
  EXECUTE.
