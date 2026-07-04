# Payroll → GL Account Mapping — Completion Plan (Takeover)

## Verification summary
The previous agent's five phases are **mostly real**, with three exceptions that make the subsystem fall short of the enterprise-grade goal. Phases 1–4 are genuinely wired (coverage table, provenance + revert, upgrade diff, dry-run simulator, compute-time issue writer). Phase 5 (effective-dating + branch scope) was built but **never connected to the posting path**, so it is dead infrastructure today. The preview is also currently failing to boot.

This plan closes only the verified gaps; it does not redo completed work.

## Work items

### A. Fix the broken preview (blocker, do first)
The dev server returns 500 for `@tanstack/react-start` hydration modules, so nothing above can be visually verified.
- Root-cause the Vite transform/dev-server failure (check dev server output, recent migrations/types regen, and any syntax break introduced in the mapping work).
- Confirm `/hr/payroll/configuration/accounts` renders end-to-end before continuing.

### B. Make effective-dated bindings actually authoritative (closes the real Phase-5 gap)
Today `resolve_default_account_binding` and `default_account_setting_bindings` are populated by a sync trigger but read by nobody; `post-payroll-gl` reads `default_account_settings` directly, so re-posting a historical run resolves against *today's* mapping.
- Change account resolution in `post-payroll-gl` to resolve each `setting_key` through `resolve_default_account_binding(key, org, business, branch, as_of)`, passing the **run's period end date** as `as_of` (not `now()`), so historical re-posts are temporally correct.
- Apply the same resolver in the compute-time check and in the dry-run simulator path so preview, compute-gate, and post all agree.
- Keep `default_account_settings` as the write surface (trigger continues mirroring into bindings); add a guard test that the two never diverge.
- If any `setting_key` fails to resolve through the binding, fall back to the flat table once with a logged diagnostic (migration-safety net), then remove the fallback after a release.

### C. Branch-scoped overrides (closes G12)
- Consume `branch_id` in the resolver call chain in B (document `branch_id` = the entity/run's branch, not the active UI branch, matching `resolveDefaultAccount.ts` semantics).
- Add a branch-override affordance on the mapping row in `AccountMapping.tsx` reusing the `branch_setting_overrides` interaction pattern: pick branch → bind account → writes a branch-scoped binding row through the existing trigger-guarded path.
- Coverage table gains a per-branch status column / expansion so an accountant sees company default vs branch override at a glance.

### D. Harden the compute-time gate (fail-loud, closes intent of Phase 4)
- In `compute-payroll`, stop swallowing the mapping-check `try/catch` as "non-fatal". A failure of the check itself must surface (write a `payroll_run_issues` blocker + return `mapping_issue_count`), never silently pass.
- Ensure the run cannot advance past draft while `GL_MAPPING_MISSING` / `GL_MAPPING_ROLE_VIOLATION` blocker issues are open (verify the approval gate reads these codes).

### E. Test coverage (closes the admitted gap)
- pgTAP: `payroll_gl_upgrade_diff` new/changed/deprecated buckets; `revert_payroll_mapping_to_pack_default` goes through the role trigger and rejects invalid pack templates; provenance `source` stamping per RPC; `resolve_default_account_binding` effective-date + branch-override resolution; binding/flat-table non-divergence.
- Edge/dry-run: `post-payroll-gl` `dry_run` returns a balanced JE and writes nothing; compute blocks on missing mappings.
- RTL: coverage table renders sources/status/drill-throughs; upgrade-diff panel accept/keep/override.

## Explicit non-goals
- No changes to `journal_entries` / `journal_entry_lines` schema.
- No new posting keys (still derived from statutory rules).
- No migration of non-payroll `default_account_settings` keys (Finance page keeps AR/AP/tax).
- No pack-authoring workflow changes.

## Sequencing
A → B → D → C → E. B and D are the substance (they turn Phase 5 from decorative into load-bearing and make the safety gate real); C and E round it out to production quality.
