# Reconciliation Engine — Phase 0 Verdict and Phased Plan

Scope: bank reconciliation only. Evidence below is from the live database and
the repository, gathered this turn. Nothing has been changed.

## Verdict in one paragraph

The accounting foundation is **sound and already single-seam**: propose →
confirm → reject → reverse, all SECURITY DEFINER, `search_path`-pinned, revoked
from `anon`, posting only through `post_journal_entry_atomic`. What is broken
sits *above* it: a browser-side matching engine that auto-posts on a confidence
score, a rules engine that reads a table the rules UI never writes, and a rule
executor that would abort on a CHECK constraint if it ever ran. There is no
reconciliation AI in the accounting path today, and none is needed before those
three defects are closed. No new ML infrastructure is justified by the evidence.

## Findings

Legend: **CD** confirmed defect · **VA** valid existing architecture ·
**AR** architectural risk · **UNK** unknown, needs investigation.

### VA-1 — The accounting seam is correct and is the only posting path
Evidence: `bank_match_propose / bank_match_confirm / bank_match_reject /
bank_match_reverse` all `prosecdef=true`, `proconfig={search_path=public}`,
`anon EXECUTE = false`. `bank_match_candidates` is `STABLE`.
`reconcile_bank_transfer_atomic` is a thin shim: it calls `bank_match_propose`
then `bank_match_confirm` with idempotency key `bxfer:<txn>`. The manual sheet
(`useBankTransactions.reconcileTransaction`) does the same with key
`brecon:<txn>`. ADRs 0123/0144/0147/0149 plus SQL and vitest ratchets exist.
Decision: **preserve unchanged**. Phases 1–6 consume it; nothing replaces it.

### CD-2 — A second, client-side matching engine that auto-posts
Evidence: `src/hooks/useBankTransactions.ts` `autoMatchTransactions`
(≈lines 430–560) re-implements amount/reference/description matching **in the
browser**, then auto-applies any match with `confidence >= 0.85` by calling
`reconcileTransaction`, which posts real settlement. It never calls
`bank_match_candidates`. Entry point: `src/pages/BankReconciliation.tsx:268`.
Impact: reproduces exactly the duplicate ADR-0147 exists to prevent — a receipt
already recorded in Undeposited Funds is invisible to it, so it settles the
invoice a second time. It is also client-side domain logic and a score-driven
posting.
Decision: **delete the client engine**; the button re-points at
`bank_match_candidates`, and only tier `deterministic` may be applied in bulk,
via propose+confirm, one line at a time, with the existing idempotency key.

### CD-3 — Rules are authored into one table and executed from another
Evidence: the rules UI (`RulesListPage`, `RuleCreatePage`, `RuleEditPage`,
`BankFeeds`) uses `useTransactionRules` → `transaction_categorization_rules`
(1 row). The executor `apply_reconciliation_rules` reads
`bank_reconciliation_rules` (0 rows), which only `useReconciliationRules` reads.
Impact: reconciliation rules are inert. Every authored rule does nothing.
Decision: one rules table. Keep `bank_reconciliation_rules` (it is what the
executor, the ADRs and the SQL ratchets already reference), migrate the
categorisation rows into it, and re-point the authoring hook. Do not keep both.

### CD-4 — The rule executor violates a CHECK constraint and aborts
Evidence: `apply_reconciliation_rules` runs
`UPDATE bank_transactions SET match_source = 'rule:' || _rule.name`, while
`bank_transactions_match_source_check` is
`CHECK (match_source = ANY (ARRAY['manual','rule','ai']))`.
Impact: the first rule match raises 23514 and rolls back the whole run. This is
the same class of defect ADR-0149 recorded for `'unreconciled'`.
Decision: write `'rule'`; carry the rule identity in the existing `rule_id`
column on `bank_reconciliation_matches`.

### VA-5 — Rule *semantics* are already correct
Evidence (same function): rules are skipped when the line is `settled` or
`proposed`, skipped when any document/payment candidate exists
(`DOCUMENT_CANDIDATE_EXISTS`), skipped on equal-priority conflict
(`AMBIGUOUS_RULE_MATCH`), never auto-posted on an `ambiguous` tier, and a failed
auto-post degrades to a proposal. This matches Odoo's reconcile-model and
QuickBooks' bank-rule posture (rules categorise the residual; they never
override a document).
Decision: preserve the semantics; repair only CD-3/CD-4 around them.

### AR-6 — Rules carry no branch scope
Evidence: `bank_reconciliation_rules` columns include `organization_id`,
`business_id`, `bank_account_id` — no `branch_id`, while `bank_transactions`
and `bank_reconciliation_matches` both have one.
Impact: a branch-scoped operator's line can be categorised by another branch's
rule. Cheap to fix now: 0 rows exist.
Decision: add nullable `branch_id` (NULL = all branches), filter in the
executor, expose in the form.

### CD-7 — The AI matching call ships bulk tenant data and has no accounting role
Evidence: `useBankTransactions.ts:517` posts
`{transactions, invoices, bills, expenses}` arrays to the `ai-assistant` edge
function, type `match_transactions`, whose prompt asks it to match bank lines to
documents. It is reached only from CD-2's engine. `ai_usage_logs` = 122 rows
(all surfaces, not reconciliation-specific).
Decision: remove this call with CD-2. AI does not rank or select matches in the
accounting path. Any future AI role is explanation only (Phase 6).

### CD-8 — Dead AI columns and a UI that reads them
Evidence: `bank_transactions.ai_suggested_category / ai_confidence /
ai_reasoning` — 0 of 4 rows populated; nothing writes them; `BankFeeds.tsx:183`
offers a one-click accept of `ai_suggested_category`, i.e. a button that can
never fire.
Decision: remove the UI surface in Phase 3; retire the columns in Phase 7 after
confirming no reader remains.

### VA-9 — Decision history already exists; no new table is justified
Evidence: `bank_reconciliation_matches` carries `status`, `match_type`,
`rule_id`, `confidence`, `evidence` (jsonb), `created_by/proposed_by/
confirmed_by/rejected_by/reversed_by` with timestamps, plus
`business_id`/`branch_id`. Confirmed 3, rejected 1 today.
Decision: historical intelligence is a **read model over this table**, not a new
store. Revisit only if a measured query cannot be served from it.

### UNK-10 — Items to establish before Phases 2 and 6
- Whether `bank_match_candidates` (16.8 kB body) filters by `branch_id` as well
  as `business_id`, and what its bounded-scan limits are.
- Whether `bank_reconciliation_rules` RLS matches the executor's assertions.
- Real query plans for candidate generation at 10k+ lines (today: 4 rows, so no
  performance claim can honestly be made).
These are Phase 2 entry criteria, not blockers for Phase 1.

## Answers to the final-deliverable questions (short form)

Deterministic and authoritative: the four seams plus
`post_journal_entry_atomic`, `record_multi_invoice_payment`,
`record_multi_bill_payment`, `require_exchange_rate`. Rules: categorise the
residual only, subordinate to documents, propose by default, auto-post only when
unambiguous. History: a read model over `bank_reconciliation_matches`, used to
*rank and explain*, never to post. AI: explanation and ambiguity narration only,
over context retrieved per-line by the existing candidate engine — no new
infrastructure, no vector store, no training environment, no ML service; the
evidence shows deterministic candidates plus history cover the ranking problem.
AI must never propose, confirm, categorise or post. Isolation is enforced in the
database by `assert_can_reconcile_bank` plus per-row `business_id`/`branch_id`,
never by the UI.

## Execution order

**Phase 1 — foundation (no behaviour change).** Confirm VA-1 by test, not by
reading: add a ratchet asserting no module outside the seam posts settlement.
Fix CD-4. Entry criteria for Phase 2: existing banking SQL tests green.

**Phase 2 — candidate engine.** Resolve UNK-10 (branch filter, RLS, bounded
scans). Add branch filtering if absent. Record measured limits.

**Phase 3 — manual reconciliation.** Delete CD-2's client engine and CD-7's AI
call. Re-point the bulk button at `bank_match_candidates`, `deterministic` tier
only. Remove CD-8's dead surface.

**Phase 4 — rules.** Fix CD-3 (single table + data migration + re-pointed
authoring hook), AR-6 (branch scope), and surface the executor's `skipped`
reasons in the UI. Wire an explicit "Apply rules" action — today nothing calls
`apply_reconciliation_rules`.

**Phase 5 — decision history.** Read model over
`bank_reconciliation_matches`; feed candidate ranking as one more evidence
class, clearly labelled as history, never as a document.

**Phase 6 — AI.** Only if Phase 5 leaves a measured gap. Explanation only,
per-line context assembled by the candidate engine, no mutation authority.

**Phase 7 — ratchets.** Tests for: no client-side matching, one rules table,
`match_source` vocabulary, rules cannot outrank documents, AI has no write path.
Retire dead columns.

Each phase is verified against the live database before the next begins. This
file is the execution record and will be updated as phases complete.
