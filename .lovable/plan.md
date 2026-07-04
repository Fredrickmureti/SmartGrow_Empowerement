
# Payroll → GL Account Mapping — Architectural Audit & Upgrade Plan

## 1. What this subsystem actually is

A **payroll posting key** (`salary_expense`, `paye_payable`, `nssf_employer_expense`, `net_salary_payable`, `payroll_clearing`, …) is a stable symbolic identifier the payroll engine emits when it turns a payslip into debits and credits. A mapping row binds one posting key → one postable Chart‑of‑Accounts leaf in one (org, business). The mapping table is the pivot between the *localization‑defined* payroll rulebook and the *tenant‑owned* general ledger.

Business events that consume it: install localization pack → seed CoA → auto‑map keys → payroll readiness → compute run → **post-payroll-gl** builds a balanced JE (`journal_entries` + `journal_entry_lines`) → posts to GL → feeds trial balance, P&L, balance sheet, cash flow, statutory returns, audit trail.

Accountants visit the page (a) once during implementation, (b) whenever a new statutory rule / earning / deduction / loan type is published, (c) when CoA is restructured, (d) when a posting failure surfaces a gap.

## 2. Current architecture (traced from code)

```text
localization_packs ── install-localization-pack ──► accounts (CoA)
                                                │
                                                ├─► payroll_statutory_rules
                                                │
                                                └─► payroll_apply_proposed_mappings  ─┐
                                                                                      ▼
                                        default_account_settings (setting_key → account_id, per org+business)
                                          ▲                                           │
   Finance Settings (DefaultAccountsConfig)│                                           │
   Payroll → AccountMapping.tsx           │                                           │
   MissingMappingsDialog (event-driven)   │                                           ▼
                                          │              trg_default_account_settings_payroll_role
                                          │              → _payroll_assert_mapping_role (role/type/header guard)
                                          │
   payroll_gl_readiness(org,biz) ─── required keys (core + per active statutory rule) + is_mapped + heuristic suggestion
                                          │
   Payroll Overview: PayrollGlReadinessBanner + refresh_payroll_setup_status
                                          │
                                          ▼
   compute-payroll → payroll_runs / payslips / payslip_lines
                                          │
                                          ▼
   post-payroll-gl  ── payroll_validate_post_mappings(run_id) ── reads default_account_settings ──► journal_entries
                                          │
                                          ▼
   payroll_generate_reclassification_je (Wave-3 correction path, ADR-0022)
```

### Strengths already in place
- **Single canonical writer** — every insert/update to `default_account_settings` for payroll keys is trapped by `_payroll_assert_mapping_role` (ADR-0022). Salary→COGS, header accounts, wrong `account_type`/`detail_type`, non-existent accounts are all rejected at table tier.
- **Dynamic required-key derivation** — `payroll_gl_readiness` computes required keys from active `payroll_statutory_rules`; no hardcoded country matrix (`no-hardcoded-payroll-role-matrix.test.ts`).
- **Defense-in-depth at post time** — `post-payroll-gl` calls `payroll_validate_post_mappings` before writing the JE; pinned by `post-payroll-gl-validates-mappings.test.ts`.
- **Reclassification path** — historical misposts are correctable in-product via `payroll_generate_reclassification_je` with an idempotency lock on `payroll_runs.reclassification_journal_entry_id`.
- **Install-time auto-map** — `install-localization-pack` runs readiness → apply suggested → create+map remainder, so a fresh tenant lands fully mapped.
- **Tests** pin: trigger guard, single-overload apply-mappings, no-drift architecture, role-suggester semantics (`payroll_role_suggester_test.sql`), readiness contract.

### Genuine architectural gaps (evidence-backed)

| # | Gap | Evidence |
|---|-----|----------|
| G1 | **Dual UI surface, no source-of-truth for payroll keys.** Payroll `AccountMapping.tsx` and Finance `DefaultAccountsConfig` both edit `default_account_settings` with different UX (payroll grouped by kind; finance flat). They can disagree on which keys are visible. | `src/pages/hr/payroll/AccountMapping.tsx`, `src/components/finance/DefaultAccountsConfig.tsx` |
| G2 | **No versioning / effective dating** on mappings. `default_account_settings` has no `effective_from` / `effective_to`. Re-mapping mid-period silently changes future *and* historical resolution logic if a run is re-posted. | schema of `default_account_settings` (8 cols, no temporal cols) |
| G3 | **No mapping-level audit trail visible in UI.** `settings_audit_log` exists but the Payroll mapping page shows no "last modified / by whom / previous value / source (pack vs. override vs. manual)". | UI has only `label`, badge, picker; no history column |
| G4 | **Source provenance is not tracked.** We cannot answer "is this mapping localization-default, pack-upgrade auto-migrated, or tenant override?" A pack upgrade cannot know which rows are safe to refresh. | `default_account_settings` has no `source` / `origin_pack_version` |
| G5 | **Suggestion coverage is thin.** `payroll_gl_readiness` returns *one* suggested account via a name/code heuristic; when NULL the UI shows nothing. No "closest matches" list, no confidence, no cross-org learning. | `payroll_role_suggester_test.sql` shows single-column suggest |
| G6 | **Pack-upgrade behavior is undocumented in-UI.** Installing a newer pack version can add posting keys; the readiness banner surfaces the count but the mapping page has no "new since upgrade" section, no diff, no bulk resolve-for-new-keys. | grep shows no "new since" flow in `AccountMapping.tsx` |
| G7 | **First-glance signal is a single badge** ("All 10 mapped"). No coverage matrix, no per-run posting simulation, no drill-down into which statutory rule / employer contribution / loan type produced the key. | header block in `AccountMapping.tsx` |
| G8 | **Navigation is one-way** — the "Open Chart of Accounts" link is a plain route; no drill-through from a mapping row into the CoA account, no reverse "which mappings use this account?" view, no "usage in last N runs". |
| G9 | **Custom-rule extensibility path is invisible.** A tenant-added statutory rule or salary component that emits a new posting key relies on `payroll_gl_readiness` picking it up. There is no UI hint of *why* a key appeared, and no publisher-side declaration that a pack rule is "self-mapping" vs "requires accountant". |
| G10 | **Overrides are permanent and silent.** A tenant-override survives pack upgrades but there is no "revert to pack default" button and no drift diff vs. current pack recommendation. |
| G11 | **No posting simulation.** Accountant cannot preview "if I post the current run, this is the JE that will be produced" from the mapping page. `post-payroll-gl` is the only way to learn the mapping is semantically wrong-but-eligible (e.g. right type, wrong sub-account). |
| G12 | **Branch scope is inconsistent** — accounts query filters `!business_id || business_id === currentBusiness`, but `default_account_settings` writes only carry (org, business). Branch-level overrides are impossible even though other finance settings support branch overrides (`branch_setting_overrides`). |

### Failure modes traced
- Account archived after mapping → trigger blocks reads/writes at next map edit, but existing mapping row survives; `payroll_validate_post_mappings` catches it at post time. Good, but late.
- Account deleted → FK on `default_account_settings.account_id` (verify: currently `NULL`able / RESTRICT?) determines whether the mapping row is orphaned or the delete is blocked. Needs explicit assertion.
- Localization pack upgrade adds a new key → readiness picks it up, banner fires, but only if the accountant visits Overview or Mapping; no proactive notification.
- CoA fully recreated (rare) → all mapping rows point at dead IDs; nothing recovers automatically. Need a "rebind by code" migration helper.

## 3. What "enterprise-grade" requires (SAP HCM / Oracle Payroll / Workday parity)

1. **Symbolic posting classes with effective-dated bindings** to real ledger accounts.
2. **Source provenance** on every mapping: `pack_default`, `pack_upgrade`, `tenant_override`, `system_seed`.
3. **Publisher-declared default mappings** shipped inside the localization pack (already partially true via `localization_pack_account_templates` — needs to feed the mapping table directly with source=`pack_default`).
4. **Coverage dashboard** (not a badge): keys × companies × branches × status × source × last verified.
5. **Posting simulation** on any current or draft run.
6. **Bidirectional drill-through** mapping ↔ CoA ↔ statutory rule ↔ recent JEs using this mapping.
7. **Upgrade diff** on pack version change: new keys, deprecated keys, changed publisher recommendation.
8. **Audit log surfaced in-page** (who / when / from-to / reason).
9. **Revert to pack default** and **override with reason** actions.
10. **Fail-loud, fail-early**: readiness banner, blocking `app_setup_status`, and post-time validator (present) + **compute-time short-circuit** so mis-mapped runs never reach approval.

## 4. Recommended upgrade — implementation plan

Delivered as five sequenced phases, each independently shippable and covered by tests.

### Phase 1 — Consolidate the surface (no schema change)
Goal: eliminate G1, upgrade G7/G8 first-glance UX using data already available.
- Make `PayrollAccountMappingPage` the canonical accountant surface. Redirect Finance Settings' payroll-key rows to it (finance page keeps *non-payroll* keys — AR, AP, sales tax, retained earnings — only).
- Replace the badge with an enterprise coverage table: columns *Posting Key · Kind · Required Type · Account (code/name/type) · Source · Status · Last Modified · Last Used in Run · Actions*.
- Group by `kind` (core, employee_payable, employer_expense, employer_payable) with subtotal chips.
- Add row-level drill-throughs: → CoA account, → statutory rule (when `rule_code` present), → last N journal entries that debited/credited this account for payroll (query `journal_entry_lines` joined via `payroll_runs`).
- Show suggestion confidence and top-3 candidates instead of one.
- Wire `settings_audit_log` into a per-row "History" popover.

### Phase 2 — Provenance & audit (small schema change)
Goal: close G3/G4/G10.
- Migration: add `source text` (`pack_default|pack_upgrade|tenant_override|manual`), `origin_pack_id uuid`, `origin_pack_version text`, `overridden_at timestamptz`, `overridden_by uuid`, `override_reason text` to `default_account_settings`. Backfill: existing rows → `manual`; rows matching current pack template → `pack_default`.
- Update `payroll_apply_proposed_mappings` and `payroll_create_and_map_account` to stamp source correctly.
- Add `revert_payroll_mapping_to_pack_default(org, biz, setting_key)` RPC that resolves the current active pack's template and re-applies through the trigger.
- Add "Overridden — Revert" action + reason capture in UI.

### Phase 3 — Pack upgrade diff (uses Phase-2 data)
Goal: close G6/G9.
- New RPC `payroll_gl_upgrade_diff(org, biz)` comparing current mappings vs. active pack version's templates and `payroll_gl_readiness` output: returns `{new_keys[], changed_recommendations[], deprecated_keys[]}`.
- Mapping page shows a dismissible "Since pack v1.4 → v1.5: 3 new posting keys, 1 recommendation changed" panel with per-row accept/keep/override controls.
- `install-localization-pack` writes an upgrade event to `pack_migration_log`; the panel reads from there so it survives page reloads.

### Phase 4 — Posting simulation & compute-time short-circuit
Goal: close G11 and move the last-line-of-defense from post to compute.
- New RPC `payroll_simulate_run_posting(run_id)` reusing `post-payroll-gl` account resolution but returning the JE payload as JSON instead of writing.
- `AccountMapping.tsx` gains a "Preview posting for [latest draft run]" button surfacing the resulting balanced JE, per-account totals, and any resolution warnings.
- Extend `compute-payroll` to call `payroll_validate_post_mappings` at compute finalize, blocking approval when mappings are missing/invalid (not just at post).

### Phase 5 — Branch & effective-dating (larger, optional for later)
Goal: close G2/G12.
- Introduce `default_account_setting_bindings` (setting_key, org, business, branch nullable, account_id, effective_from, effective_to, source, …) with a lookup helper `resolve_default_account(setting_key, org, biz, branch, as_of)`. Migrate `default_account_settings` writes behind this helper. Retire the flat table over N releases with a compat view.
- Add branch-scoped override UI reusing the pattern from `branch_setting_overrides`.

## 5. Explicit non-goals
- No change to `journal_entries` / `journal_entry_lines` schema.
- No new payroll posting keys (still derived from statutory rules).
- No pack-authoring workflow changes in Phase 1–4.
- No migration of non-payroll `default_account_settings` keys (AR/AP/tax) — Finance page continues to own those.

## 6. Test additions (each phase)
- Phase 1: RTL tests for coverage table, drill-through links, audit popover; pgTAP for "last-used-in-run" query correctness.
- Phase 2: pgTAP for source-stamping in each RPC; regression test that `revert_payroll_mapping_to_pack_default` goes through the trigger and rejects invalid pack templates.
- Phase 3: pgTAP for `payroll_gl_upgrade_diff` new/changed/deprecated buckets; UI snapshot test on the diff panel.
- Phase 4: pgTAP for `payroll_simulate_run_posting` balance invariant; edge test proving compute blocks on missing mappings; existing `post-payroll-gl-validates-mappings.test.ts` remains green.
- Phase 5: pgTAP for effective-date resolution + compat view; RLS test for branch-scoped rows.

## 7. Files that will change (Phase 1 & 2, concrete)
- `src/pages/hr/payroll/AccountMapping.tsx` — coverage table, drill-throughs, history, suggestion top-3, revert action.
- `src/hooks/payroll/usePayrollGlReadiness.ts` — extend to return `source`, `last_modified_at`, `last_used_run_id`, `candidates[]`.
- `src/components/finance/DefaultAccountsConfig.tsx` — hide payroll-shaped keys; add link out.
- New: `src/components/payroll/PayrollMappingHistory.tsx`, `src/components/payroll/PayrollMappingSimulator.tsx` (Phase 4).
- Migrations: `add_default_account_settings_provenance.sql`, `payroll_gl_upgrade_diff.sql`, `payroll_simulate_run_posting.sql`, `revert_payroll_mapping_to_pack_default.sql`.
- `supabase/functions/install-localization-pack/index.ts` — stamp source on writes; emit `pack_migration_log` upgrade rows.
- `supabase/functions/compute-payroll/index.ts` — call `payroll_validate_post_mappings` at finalize.

Approve to proceed with **Phase 1** first (pure UI + read-only queries, zero schema risk) and then continue phase-by-phase.
