# 13 · Production Readiness

## Purpose
A blunt, per-subsystem rating with file-anchored justification. Use this to decide what to ship, what to harden, and what to escalate before onboarding real customers.

## Rating scale
- **Enterprise Grade** — confidently usable in production today; matches industry norms.
- **Needs Improvement** — works, but has friction or gaps that will hurt at scale.
- **Architectural Risk** — works under normal conditions; a foreseeable scenario (race, drift, mis-config) will produce wrong data or hidden failures.
- **Critical Defect** — known to produce wrong data, security gap, or cannot perform a core task. Block production for affected workflows.

## Subsystem ratings

### Payroll Engine — Enterprise Grade
- Country-agnostic, snapshot-immutable rule sets (`salary_structure_rule_sets`), hand-written safe expression engine (no `eval`), dispatched purely on `computation_method`, multi-jurisdiction in a single run (`employees.statutory_country_code`).
- Strong test bench (`compute-payroll-uses-rule-set.test.ts`, `no-hardcoded-country-payroll.test.ts`, `no-dropped-payroll-tables.test.ts`, `assert-payroll-ready-single-overload.test.ts`).
- Comparable to: Odoo (rule-graph), Workday (calc rules) — slimmer model but the right shape.

### Payroll GL Posting — Enterprise Grade
- Mapping integrity guarded at three layers (DB trigger, RPC backstop, edge-fn preflight) per ADR-0022.
- Idempotent via `journal_entries.source_type`+`source_id`. Fiscal period lock + SoD gate enforced.
- Drift monitoring (ADR-0032) is daily and append-only, with streak escalation. Real incident closed by trigger.
- Comparable to: Workday/ADP commit-and-post model.

### Statutory Liabilities & Remittances — Enterprise Grade
- `payroll_liabilities` is a single open-items ledger (ADR-0033 pattern reused). Allocations recompute via trigger. Bank-account type guard.
- Authority/due-date data is pack-driven (no country hard-coding).
- Comparable to: Odoo's `account.payment` model applied to statutory; cleaner than ADP's per-country specialization.

### Tax Certificates & Statutory Returns — Needs Improvement
- Pipeline is solid (idempotent, supersede-on-regenerate, A4 lock, token diagnostics).
- **Limitation** (`LOCALIZATION_PACKS.md:111`): certificate `body` blocks are decorative — `generate-tax-certificate/index.ts:260` uses hard-coded PDF columns; only `template.code`, `display_name`, `layout` are consumed. Real per-country layout differences cannot be expressed without code changes. Same applies to returns: declarative `columns[]` works but layout is fixed.
- Closing this gap is straightforward (wire the block renderer) and unlocks much faster per-country onboarding.

### Localization Packs — Architectural Risk
- Authoring + schema validation + audit log + token registry are strong (`trg_assert_pack_payload_valid`, `_shared/renderTokens.ts`).
- **Risk #1 (medium-high)**: Publish edge function does not invoke `lint-localization-pack`. ADR-0036 §I6 expects it. Malformed packs can be snapshotted.
- **Risk #2 (medium)**: `PublishToggle` on `AdminLocalizationPacks.tsx:200` flips `is_published` directly via service role — bypasses any validation.
- **Risk #3 (medium-high)**: Promotion does not re-seed runtime rows. Bumping `installed_localization_packs.pack_version` does not refresh `payroll_statutory_rules` etc. Tenants on old runtime data continue computing on stale rules.
- **Risk #4 (medium)**: `PackDiffView` receives empty `before/after` because diff stored as `changelog.tables[t][{id,kind,fields}]`. Tenants approving upgrades cannot see what's changing.
- **Risk #5 (low-medium)**: `pack_requirements` not enforced by install RPC; identifiers can be missing post-install.
- **Risk #6 (UNVERIFIED)**: `payroll_rule_types` table not written by install — hydration path unclear.

### HR Employee Lifecycle — Needs Improvement
- Strong building blocks: `employments`, denormalization trigger, position history, `v_employees_safe`, `get_employee_pii` with audit.
- **Risk**: `lifecycle_status` transitions not DB-enforced — FE can write any value.
- **Risk**: `employee_number_next_seq` incremented in app code → race conditions at scale. Migrate to a Postgres sequence.
- **Risk**: No DB UNIQUE blocking two `running` contracts per employee.
- **Risk**: Compensation history has `submitted_at/by` + `approved_at/by` columns but **no approval UI**; merit cycle may bypass governance.

### Attendance, Leave, Timesheets, Shifts — Needs Improvement
- Rich capture model (kiosk, biometric, web, manual, corrections, geofence/selfie/device trust).
- **Risk**: `leave_requests` rejection is a direct UPDATE, not an RPC — no server-side balance rollback or second-approver guard.
- **Risk**: `check-leave-expiry` has no idempotency — duplicate emails possible if cron double-fires.
- **Risk**: `attendance_device_trust` has no UI for HR to review trust requests; employees only see an error.
- **Risk**: `work_schedules` / `work_schedule_days` tables exist but no consumer is traced.
- **Risk**: Shift swap approval has no client-side code performing the actual assignment swap — may be a missing step or undocumented trigger.

### Employee Self-Service Portal — Enterprise Grade (with one HIGH risk)
- Clean `/me/*` route tree, RLS-scoped reads, write paths via RPCs with SoD triggers, PII masked at the view layer.
- **HIGH risk**: `accept-invitation` runs `admin.auth.admin.createUser` **outside** the SQL transaction. A crash between the Deno call and `accept_organization_invitation_atomic` leaves an auth user with no org role — manual remediation required.
- Architecture invariants well-tested (`invitation-no-tabs`, `portal-identity-invariants`, `portal-payslip-contract`, `sod-coverage`, two pgTAP files).

### Separation of Duties — Enterprise Grade
- Trigger-based enforcement on every sensitive table; coverage test ensures parity with the action catalogue.
- Override flow requires co-signer, ≥12-char reason, 1-hour expiry, single-use.
- pgTAP test covers the four core invariants.
- Comparable to: SAP GRC / Oracle SoD but database-resident, which is more reliable than middleware.

### Documents (Payslips & Certificates) — Enterprise Grade
- All amounts sourced from `payslip_lines` (no legacy columns). Statutory paper locked. Self-service bypass correctly scoped to employee's own `user_id`.
- Immutability guard is pgTAP-verified to not contain any country tokens — strong country-agnosticism guarantee.

### Finance Drift & Period Close — Enterprise Grade
- Daily snapshot, append-only log, streak escalation, real-incident lineage in audit folder.
- ADR-0032 fully realised.

## Cross-cutting risks (consolidated)

| # | Subsystem | Risk | Severity |
|---|---|---|---|
| 1 | Portal | `admin.createUser` outside SQL tx in `accept-invitation` | HIGH |
| 2 | Localization | Publish does not lint | HIGH |
| 3 | Localization | Promote does not re-seed runtime rules | HIGH |
| 4 | HR | `employee_number_next_seq` race | MEDIUM |
| 5 | HR | No DB constraint for single `running` contract | MEDIUM |
| 6 | HR | `lifecycle_status` transitions not DB-enforced | MEDIUM |
| 7 | HR | Compensation history approval UI missing | MEDIUM |
| 8 | Leave | Reject is direct UPDATE, not RPC | HIGH |
| 9 | Leave | `check-leave-expiry` not idempotent | MEDIUM |
| 10 | Attendance | No HR UI for `attendance_device_trust` | MEDIUM |
| 11 | Attendance | `work_schedules` table unconsumed | MEDIUM (clarify intent) |
| 12 | Shifts | Swap approval doesn't visibly swap assignments | MEDIUM |
| 13 | Localization | `PackDiffView` shows empty diff | MEDIUM |
| 14 | Localization | `pack_requirements` not enforced at install | MEDIUM |
| 15 | Documents | Certificate/return body blocks decorative | MEDIUM (limits country expansion) |
| 16 | Talent | `talent-cycle-tick` silent failure stalls cycles | MEDIUM |
| 17 | HR | `hr_document_categories` not FK-linked to `employee_documents` | LOW/MED |
| 18 | HR | `retention_days` never enforced | LOW |
| 19 | Onboarding | Template item reorder non-atomic | LOW |
| 20 | Position history | Writer authority (trigger vs client) unclear | LOW (clarify) |

## Comparative notes vs mature systems

- **Odoo (HR/Payroll module):** Our salary-rule graph and snapshotting model are conceptually identical and arguably stricter (immutable rule-set hash on each payslip). Odoo lacks our trigger-level mapping integrity (ADR-0022); we are ahead there.
- **Workday Payroll:** Workday's "calculations" engine is country-pluggable; we match the shape via packs + `computation_method`. Workday's authoring tools and impact analysis are far more mature; close the lint-on-publish gap and ship a real diff view before claiming parity.
- **SAP SuccessFactors Employee Central Payroll:** SF EC-Payroll defers to on-prem ERP for compute; we own compute end-to-end in an edge function. Our trade-off: simpler topology, single-language stack, but less battle-tested for very large headcounts. Stress-test `compute-payroll` at 5k–10k employees per run.
- **Oracle HCM Cloud:** Oracle's "Fast Formulas" + flexfields are similar to our expression engine + `parameters` jsonb. We are more constrained (200 tokens, depth 32) which is a *good* default — keep it.
- **ADP Workforce Now:** ADP hides statutory complexity behind a managed service. We expose it via packs. The risk is operational maturity: ship the lint-on-publish gate, the diff view, and a remediation workflow for `payroll_diagnostics`.
- **UKG Pro:** UKG's "intelligent scheduling" exceeds our shift module today. Our `work_schedules` tables look like a placeholder for that — decide whether to invest or remove.

## Production-ready verdict

| For | Verdict |
|---|---|
| Single-country, small/medium tenant (≤500 employees) using KE-style PAYE | ✅ Ready — fix risks 1, 2, 3, 8 first. |
| Multi-jurisdiction tenant | ⚠️ Pre-ready — close localization risks (2, 3, 13, 14) + finalize block renderer for certificates/returns. |
| 1k+ employee single-run | ⚠️ Validate compute-payroll throughput; consider chunking. |
| Heavy shift-based industries (retail, hospitality, healthcare) | ⚠️ Shift module needs the swap-apply step and a schedule consumer. |
| Year-end statutory filing | ✅ for current packs; ⚠️ pending block renderer for arbitrary country layouts. |
