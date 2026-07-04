# Work Entry Types — Enterprise Payroll Architecture Review & Remediation

## 1. Business-event framing

A Work Entry Type (WET) is not a lookup. It is the **classification of a unit of time** that lets payroll answer three questions before pay is calculated:

1. Did the employee earn money for this time? (`is_paid`)
2. Does this time count toward hours-worked ceilings, overtime thresholds, accrual bases? (`counts_as_worked`)
3. At what rate and against which GL bucket does it settle? (`multiplier_*`, `accounting_tag`)

The canonical event chain the subsystem must serve:

```text
Schedule ─┐
Attendance ─┼─► Approved Time ─► Work Entries ──► Structure Engine ──► Payslip Lines ──► GL Posting ──► Reports
Leave     ─┤                        ▲                    ▲                                    ▲
Timesheet ─┤                        │                    │                                    │
Overtime  ─┘                    (WET classifies)    (WET drives multiplier)          (WET drives accounting_tag)
```

Everything that follows is measured against this chain.

## 2. Current architecture (as-built)

- **Table** `payroll_work_entry_types` (org-scoped, business-scoped or NULL for "pack default").
- **Seeder** `ensure_canonical_work_entry_types(org)` inserts 6 hard-coded codes (`WORK`, `OT`, `LEAVE_PAID`, `LEAVE_UNPAID`, `HOLIDAY`, `WORKED_HOLIDAY`) with `business_id = NULL`. Called on every projector run.
- **Projector** `payroll_work_entries_project(run_id)` looks up 5 of those 6 codes *by code only*, then inserts `payroll_work_entries` rows stamped with those ids.
- **Engine** `compute-payroll/structureEngine.ts` loads all WETs into a `byId` map and folds hours via `hours × multiplier_normal + overtime_hours × multiplier_overtime` into `worked_hours['CODE']` for salary rule expressions.
- **UI** `WorkEntryTypes.tsx` + hook `useWorkEntryTypes.ts` provide CRUD scoped by `(org, business_id)`. Rows where `business_id IS NULL` render as "Pack default" and expose an **Override** action.

## 3. Architectural findings

### 3.1 Override 409 — root cause (P0)

Two contradictory unique indexes exist on the table:

| Index | Definition | Intent |
|---|---|---|
| `uq_work_entry_types_business_code` | `(org, COALESCE(business_id, sentinel), code)` | Allow one pack row + one override per business |
| `payroll_work_entry_types_org_code_uidx` | `(org, code)` | Added later; forbids any duplicate code per org |

The second index makes overrides impossible: inserting a tenant copy of `WORK` violates `_org_code_uidx` → Postgres 23505 → PostgREST 409. The generic error normaliser then relabels it as *"Someone else updated this record while you were editing"* — the message is completely misleading; there is no optimistic locking in this subsystem at all.

### 3.2 Projector cannot see overrides (P0)

`payroll_work_entries_project` resolves `v_id_work` with `WHERE code='WORK'` and no ORDER BY. Even if 3.1 is fixed and an override row exists, `LIMIT 1` semantics are undefined; the projector will randomly stamp either the pack default or the tenant row. Overrides can never reliably influence payroll behaviour.

### 3.3 "Pack default" is a lie (P1)

Despite the badge and copy, WET rows are *not* pack artefacts. There is no `localization_pack_work_entry_type_templates`, no `pack_versions` snapshot, no `pack_upgrade_proposals` fan-out (contrast with statutory rules, certificate templates, return templates, garnishment kinds — all of which do follow the ADR-0010 pack lifecycle). `localization_pack_id` on the row is always NULL. The system labels seeded org rows as "pack" purely because `business_id IS NULL`.

Consequence: adding a country or industry requires editing SQL, not shipping a pack. This contradicts ADR-0010 and ADR-0056.

### 3.4 Dead / half-wired fields (P1)

| Field | Consumer? | Verdict |
|---|---|---|
| `color` | none | dead |
| `is_unpaid_leave` | not read in projector or engine | dead (`is_paid` alone drives everything) |
| `accounting_tag` | collected by UI, ignored by engine and by `post-payroll-gl` | dead — GL posting is driven by `payroll_salary_rules.accounting_tag`, not the WET tag |
| `sequence` | ORDER BY only | fine |
| `is_pack_default` | column exists, but UI infers pack-ness from `business_id IS NULL` | duplicate signal |
| `localization_pack_id` | always NULL | dead |

### 3.5 Missing business events (P2)

Only 6 codes exist. There is no representation for: night shift, weekend premium, standby, on-call, travel, training, jury duty, suspension, distinct sick vs bereavement leave, worked-rest-day. The `WORKED_HOLIDAY` type exists but is never stamped by the projector — attendance on a public holiday still lands as `WORK`. Similarly, overtime hours land as `overtime_hours` on the `WORK` row; no row is ever stamped `OT`. Two of the six seeded types are unreachable.

### 3.6 Leave → WET mapping is hard-coded (P1)

The projector maps leave to either `LEAVE_PAID` or `LEAVE_UNPAID` purely from `leave_types.is_paid`. A tenant that has "Annual leave", "Sick leave", "Maternity", "Compassionate" all as `is_paid=true` collapses them into one WET, losing accrual base distinctions, statutory reporting distinctions, and GL routing. There is no `leave_types.work_entry_type_id` FK.

### 3.7 No optimistic locking (P2)

The table has `updated_at` but no `version` column and no If-Match handling. The 409 the user sees is a masquerade — real concurrent edits would silently last-write-wins.

### 3.8 RLS vs seeder contradiction (P2)

Write policy requires `business_id IS NOT NULL`, but the seeder writes `business_id IS NULL` (works only because it is SECURITY DEFINER). The "pack" rows are therefore structurally unmanageable by the tenant — including the platform admin — from any normal write path.

### 3.9 UX deficit (P1)

Table columns: Code, Name, Source, Paid, Worked, Multipliers, Acct tag, Actions. A payroll officer cannot see:

- how many attendance/leave/timesheet rows in the current period use this type
- how many active employees are affected
- which salary rule expressions reference `worked_hours['CODE']`
- pack vs tenant *diff* when overridden
- validation status (e.g. WET referenced by a rule but archived)

## 4. Recommended enterprise model

Adopt the Odoo/Workday pattern: WET is a **projection dimension** owned by a real localization pack, referenced by every upstream time source, and resolved by a single deterministic dispatcher.

```text
localization_pack_work_entry_type_templates  ── publish ──►  payroll_work_entry_types (business_id=NULL, pack_id set)
                                                                     │
                                                    override (clone) │
                                                                     ▼
                                                    payroll_work_entry_types (business_id set)
                                                                     │
                                                                     ▼
        leave_types.work_entry_type_id ─┐          shifts.work_entry_type_id ─┐
        overtime_requests               ─┼─►  WET resolver  ◄──────────────────┤
        holiday classification          ─┘          attendance.work_entry_type_id ─┘
                                                                     ▼
                                                    payroll_work_entries (stamped)
                                                                     ▼
                                                    engine (multiplier, is_paid, counts_as_worked)
                                                                     ▼
                                                    payslip_lines (accounting_tag)
                                                                     ▼
                                                    post-payroll-gl (WET → GL bucket)
```

## 5. Implementation plan

### Phase A — Unblock overrides (P0)

1. Drop `payroll_work_entry_types_org_code_uidx`; keep only `uq_work_entry_types_business_code`.
2. Add a helper `payroll_resolve_wet(org, business, code) RETURNS uuid` that returns the tenant row if present, else the pack row. Deterministic tie-break: `ORDER BY business_id NULLS LAST`.
3. Rewrite the six `SELECT id INTO v_id_*` lookups in `payroll_work_entries_project` to call the resolver with `v_run.business_id`.
4. Replace the misleading 409 error mapping: in `normalizeError`, distinguish 23505 (`unique_violation`) from stale-write and surface it as `"An override for this code already exists."`.
5. In `useWorkEntryTypes.overrideFromPack`, guard with a pre-check for an existing tenant row and open the edit sheet instead when found.

### Phase B — Make WET a real pack citizen (P1)

6. New table `localization_pack_work_entry_type_templates` (pack_id, code, name, is_paid, is_unpaid_leave, counts_as_worked, multiplier_normal, multiplier_overtime, accounting_tag, sequence, description).
7. Extend `publish-localization-pack-version` to snapshot WET templates into `pack_versions.snapshot` and fan out to `pack_upgrade_proposals`, matching ADR-0010.
8. Replace `ensure_canonical_work_entry_types` with a pack-installer that copies templates from the installed pack to `payroll_work_entry_types (business_id=NULL, localization_pack_id=<pack>)`. Keep the six canonical codes as a seed inside a `core_global` pack so behaviour is unchanged out of the box.
9. Tighten RLS: allow platform-admin writes on pack rows (`business_id IS NULL AND has_platform_admin(auth.uid())`), keep tenant writes as-is.

### Phase C — Wire dead fields and missing dispatch (P1)

10. Consume `accounting_tag` in `post-payroll-gl`: any `payslip_line` whose source is a WET (not a salary rule) posts against the account resolved from the WET tag. Add a mapping row per tag in `default_account_settings` (`wet:<TAG>`), guarded by ADR-0022's role trigger.
11. Add `leave_types.work_entry_type_id` (nullable FK). Projector uses it when set; falls back to `LEAVE_PAID`/`LEAVE_UNPAID` for legacy rows. UI on Leave Types adds the picker.
12. Stamp OT rows separately: in the attendance branch of the projector, split into two `payroll_work_entries` — one `WORK`, one `OT` — so the `OT` type is actually reachable and its multiplier applies.
13. Detect `WORKED_HOLIDAY`: if attendance row's date matches `public_holidays`, stamp `WORKED_HOLIDAY` instead of `WORK`.
14. Drop or repurpose `is_unpaid_leave`, `color`, `is_pack_default`. Either wire (`color` in reports, `is_unpaid_leave` as an accrual-base flag) or remove in a follow-up migration.

### Phase D — Enterprise UX (P1)

15. Replace the flat table with an operational grid whose columns are (per row): Code, Name, Source badge (Pack / Overridden / Custom, with pack version), Paid, Worked, Multipliers, GL bucket, **Usage this period** (rows in `payroll_work_entries`), **Employees affected**, **Rules referencing** (count of salary rules whose expression matches `worked_hours['CODE']`), Status.
16. Row action tray: Override, Edit, Diff-vs-pack, Archive, "Show impact" (opens a drawer with rules + last-3-runs usage).
17. Add a header KPI strip: Total types, Overridden, Unused this period, Referenced by active salary structures.
18. Fix the misleading toast copy; on unique-violation, route the user to the existing override.

### Phase E — Integrity and audit (P2)

19. Add `version int NOT NULL DEFAULT 1` + BEFORE UPDATE trigger incrementing it, and enforce If-Match in the hook. Real optimistic locking, not a mis-mapped error.
20. Cover with pgTAP: `payroll_work_entry_types_override_test.sql` (pack + override + resolver + projector picks override) and an architecture test guarding against re-introducing a global `(org, code)` unique index.

## 6. Verification strategy

- pgTAP: pack default + tenant override coexist; resolver returns override; projector stamps override id; unique-violation error surfaces the correct message.
- Deno test on `compute-payroll`: overridden multiplier changes `worked_hours['WORK']` output for the affected business but not for a sibling business.
- Vitest architecture guard: no `SELECT ... FROM payroll_work_entry_types WHERE code = ...` without `ORDER BY business_id NULLS LAST` (or without going through the resolver).
- Playwright: click Override on a pack row → tenant copy appears in the same table; toast is a success; a second Override click routes to Edit instead of failing.
- Manual: run a payroll with attendance across a public holiday and with an approved overtime request; assert three distinct WET rows (`WORK`, `OT`, `WORKED_HOLIDAY`) appear in `payroll_work_entries` and drive distinct payslip lines.

## 7. Out of scope for this slice

- Full re-modelling of leave (`sick`, `bereavement`, `maternity` as first-class WETs) — captured but deferred; Phase C step 11 makes it a one-row-per-leave-type config change afterwards.
- New shift-premium types (night, weekend) — unblocked once Phase B ships the pack template table; content work only.
- Cross-country pack marketplace — remains out of scope per ADR-0010.
