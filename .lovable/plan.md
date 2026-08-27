# Consolidation — Brick 7.1: refusals that carry their own remedy

## Verified current state (checked this session against the live database and repo)

Not taken from the previous log; each point was confirmed directly.

- **Brick 7 engine is real.** `consolidation_generate_eliminations` exists (233
  lines of PL/pgSQL) and does the work in the database: it aggregates
  `consolidation_intercompany_flows`, reverses both legs of every declared pair,
  measures the residual, applies the per-class tolerance and difference policy,
  and refuses when the policy is `refuse`. It authorises the caller against
  organisation roles before doing anything. No arithmetic was found in
  TypeScript.
- **Brick 7's user surface is real and registered.** `ConsolidationEliminations`
  page exists, is routed at `/finance/reports/eliminations`, is present in
  `ReportRegistry.ts`, `reportsNav.ts` and `src/lib/apps/registry.ts`, and is
  gated on `finance.view_consolidated`. Rule configuration exists as
  `ConsolidationEliminationRules`, rendered from `ConsolidationGroupsSettings`.
  So the previous "Brick 7 closed" claim holds for the surface itself.
- **The remedy work is genuinely NOT implemented.** There is no
  `src/lib/finance/eliminationRefusal.ts`, no remedy affordance in the refusal
  alert (lines 383–391 of `ConsolidationEliminations.tsx` render the message as
  plain text plus a toast), `ConsolidationGroupsSettings` does not read any URL
  parameter (group is local state only), and the class blocks in
  `ConsolidationEliminationRules` carry no anchors. The previous engineer's
  "what remains" list is accurate: none of it landed.
- **The reported refusal is explained by data, not a bug.** The single group,
  *Joshua Holdings Group* (presentation KES, 2 members), has **zero** rows in
  `consolidation_elimination_rules`. With no rule the engine defaults to
  tolerance 0 and policy `refuse`, so a 40,000 KES cross-currency retranslation
  residual between a USD-books member and a KES-books member must refuse. The
  group *does* have a `cta_account_id` configured, so the recommended remedy is
  available and would succeed today.

Verdict: the engine is correct, the refusal is correct, and the missing piece is
that the refusal is a dead end. This brick makes every refusal actionable.

## Architectural decision: structure the refusal, don't parse the prose

The previous engineer's plan was to write a helper that reads the English
message and infers a remedy. That is rejected: it makes the UI depend on
`RAISE EXCEPTION` wording, and any future rewording silently degrades the remedy
to nothing. Mature systems return a machine-readable diagnosis.

So the diagnosis becomes a first-class server-side concept:

```text
consolidation_diagnose_eliminations(group, from, to)   -- non-throwing preflight
        │  structured findings: class, pair, both currencies, gap,
        │  cause, whether a reserve account exists, the remedies
        │  the engine itself would accept
        ▼
  refusal / preflight panel  →  quick action  →  saveRule / settings deep-link
        │
        └── every action re-checked server-side; no client-side arithmetic
```

`consolidation_generate_eliminations` additionally attaches the same finding to
its exception as structured `DETAIL` JSON, so a refusal raised mid-run carries
identical data to the preflight. The English message stays exactly as it is —
it remains what a person reads.

## Scope of this brick

### 1. Server: a non-throwing diagnosis function
New migration adding `consolidation_diagnose_eliminations(_group_id, _date_from,
_date_to)`, SECURITY INVOKER, same authorisation test as the generator, returning
one row per class-and-pair that would refuse or produce a residual:
elimination class, both business ids and names, both base currencies, the group's
presentation currency, the signed and absolute gap, the effective tolerance and
policy (including "no rule saved" as the engine's default), a cause code
(`translation_residual`, `genuine_disagreement`, `missing_cta_account`,
`missing_difference_account`, `unmapped_account`, `uncovered_rate`,
`member_out_of_scope`), and the remedy codes the engine would actually accept for
that cause. The gap is computed by the same code path the generator uses — the
flows RPC — so preflight and run can never disagree.

The generator gains `USING DETAIL = <finding json>` on each refusal path. No
change to any refusal's wording, no change to what it accepts or produces; the
existing behaviour suite must stay green.

### 2. Client: refusal becomes a remedy panel
`ConsolidationEliminations` keeps showing the database's message verbatim, and
gains beneath it, per finding:

- a plain reading of the cause ("this is what retranslation leaves behind, not a
  figure the two companies disagree on");
- **Carry to the translation reserve** — one click, saves the class rule with
  `post_to_cta`, names the group's reserve account in the confirmation, then
  re-runs generation and reports the result;
- **Raise the tolerance above X** — one click, same flow, with the exact amount
  the engine reported pre-filled;
- **Review in settings** — deep link for the cases a single click cannot decide
  (no reserve account configured, no difference account, unmapped group account,
  uncovered rate), pointing at the exact settings section.

Quick actions appear only where the current user may manage the group, and only
where the engine would accept them (no "carry to reserve" offer when both members
already report in the presentation currency — the engine rejects it, correctly).

A preflight banner also runs the diagnosis before the user presses Generate, so a
resolvable blocker is visible without a failed run.

### 3. Deep-link and focus
- `ConsolidationGroupsSettings` honours `?consolidationGroup=<id>` and selects it
  on arrival.
- `ConsolidationEliminationRules` gives each class block a stable id
  (`consolidation-elimination-policy-<class>`), scrolls the targeted block into
  view, ring-highlights it, pre-fills the suggested policy/tolerance into the
  draft, and shows a short "you arrived here from a refused run on <period>"
  note with a single Save. No scrolling required.
- The same deep-link targets are used for the reserve-account and
  difference-account cases, focusing the field that is actually missing.

### 4. Prove it against the live tenant
Seed the missing pieces only where the tenant lacks them, then demonstrate, by
execution and recorded output:
1. diagnosis reports the 40,000 KES translation residual for
   *Joshua Holdings Group* with cause `translation_residual` and both remedies;
2. the "carry to the translation reserve" quick action makes the very next run
   succeed, with the residual landing in the reserve account and flagged
   `is_difference`;
3. the tolerance remedy also closes the loop, from a clean starting state;
4. a same-currency pair is offered the tolerance remedy but **not** the reserve
   remedy, matching the engine's own refusal;
5. a caller who cannot reach every member gets the authorisation refusal from the
   diagnosis too, not a leaked pair name.

### 5. Regression and architecture guards
Re-run the Brick 7 behaviour suite (`supabase/tests/consolidation_eliminations_test.sql`)
and the 17 consolidation architecture tests. Extend the architecture test to
assert that no remedy decision is inferred from message text in TypeScript — the
remedy set must come from the server's structured finding.

### 6. Checkpoint
Append a Brick 7.1 section to `.lovable/consolidation-brick-log.md`: what was
established, what changed, what was proven by execution, the accounting rule
enforced (a translation residual may only reach the translation reserve when a
member's books are in another currency), the security boundary, and what stays
intentionally absent.

## Explicitly out of scope

Brick 8 (persisted, versioned consolidation runs and audit trail), Brick 9
(ownership / non-controlling interest), Brick 10 (consolidated cash flow). No
placeholders are created for them. No second FX resolver, no second accounting
engine, no elimination arithmetic in the browser.
