# Consolidation — handover verification (2026-08-29) and the remaining work

## Verified this session, against the live database and the repo

Not taken from the previous engineer's log:

- **T3 (tolerance as a governed control) genuinely landed today.**
  `consolidation_tolerance_cap()` no longer exists; the currency-scaled
  `consolidation_tolerance_rounding_bound(currency)` replaced it,
  `consolidation_elimination_rules` now carries `tolerance_percent`,
  `tolerance_reason`, `tolerance_set_by/at`, and the validator rejects a percent
  outside 0–100 and demands a reason plus a named difference account above the
  bound. Migration `20260829091551…`.
- **T4 (classifying the trading residual) did not land.**
  `consolidation_generate_eliminations` contains no reference to
  `rate_basis_residual` — and no reference to `tolerance_percent` either, so the
  new percentage control is stored but never consulted by the engine.
- **T5 (security + run lifecycle) did not land.** `anon` still holds EXECUTE on
  all nine functions named for revocation: `consolidation_create_run`,
  `consolidation_finalize_run`, `consolidation_supersede_run`,
  `consolidation_diagnose_eliminations`, `consolidation_intercompany_flows`,
  `consolidation_intercompany_entry_lines`, `consolidation_elimination_evidence`,
  `consolidation_eliminations_balance`,
  `consolidation_seed_default_elimination_rules`.
  `consolidation_runs` is still empty: no run has ever been created, finalized or
  superseded, so Brick 8's lifecycle is unproven.
- **T1/T2 (one closing rate per date) are unevidenced.** The brick log's last
  entries stop at R4; nothing records the rate pinning, and no migration unifies
  member FX revaluation with group closing translation. Treated as pending.

Verdict: the plan's T1, T2, T4, T5, T6 and T7 remain open. T3 is closed.

## Order of work

### 1. Pin the rates, then remove the disagreement (T1 + T2)
Read the exact rates the engine used per member and class from
`consolidation_member_translation_rates`, and prove the 1,500 and 38,500
decompositions arithmetically before changing anything. Then make member FX
revaluation and group closing translation resolve the same closing rate from the
one authoritative resolver, so a member that has revalued correctly cannot
disagree with the group. This removes the 1,500 rather than absorbing it.
Regression: the existing FX, translation and financial-statement suites.

### 2. Classify the trading residual (T4)
Split `intercompany_trading` differences arithmetically, not by label:
- `rate_basis_residual` — fully explained by average-vs-transaction rate on the
  matched pair. Carried to a dedicated intercompany-elimination FX difference
  line in equity (the CTA-E equivalent NetSuite uses), disclosed as such.
- everything else — unrecorded revenue, unrealised profit, cut-off. Still
  refused, or posted to the named difference account per policy.
Also make the engine consult `tolerance_percent` (smaller of amount and percent
wins, as in HFM) and the per-pair override, which T3 stored but nothing reads.

### 3. Close the security hole and prove the run lifecycle (T5)
Revoke `anon` EXECUTE on the nine functions above; add an architecture/SQL guard
that fails if a consolidation function is ever granted to `anon` again. Then
drive a genuine create → finalize → supersede against Joshua Holdings Group and
prove a finalized run's figures survive a later member rate edit unchanged.

### 4. Live elimination simulation (T6)
With 1–3 in place, regenerate against Joshua Holdings Group and record from
actual output: which pairs matched, residual by class, where each residual
landed, whether the consolidated trial balance still balances, and that both
original refusals are gone because the rates agree and the residual is correctly
classified — not because a tolerance was widened.

### 5. Artifact acceptance gate (T7)
Cross-Company Comparative, Consolidated Trial Balance, Consolidated Statements,
Intercompany, Eliminations — screen, PDF and Excel each: authoritative data
source, screen-to-artifact parity, totals reconciliation, group (not active
business) identity, preserved account/entity traceability, truthful run versus
export labelling, typography and pagination, and isolation for a user entitled to
only some members. Evidence per artifact from regenerated files inspected page by
page, plus the entitled-to-some-members case run for real.

Each step ends with a brick-log entry recording what was established, changed,
verified by execution, and left intentionally unimplemented.

## Not in scope

No non-controlling interest, no equity method, no consolidated cash flow.
Brick 9 starts only after step 5 passes.

## Technical notes

- No second FX resolver and no second accounting engine: translation keeps
  consuming `consolidation_member_translation_rates` / `fx_rate_on`, and
  eliminations keep consuming the intercompany and translation functions.
- New objects follow the established pattern: create, GRANT to `authenticated`
  and `service_role` only, RLS on, organization-scoped policies, guard trigger,
  change-log trigger.
- The front end reads engine output and writes only policy rows; elimination
  arithmetic stays in SQL, enforced by the existing architecture tests.
