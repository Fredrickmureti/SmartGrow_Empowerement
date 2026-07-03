# Salary Structure Lifecycle — Enterprise Edit / Rename / Delete

## What you're seeing today

- **No Edit button** anywhere on a structure card. Name, code, description, active flag cannot be changed after creation. `useSalaryStructures.ts` has no `updateStructure` mutation.
- **No Delete button** on the card either (only Rule graph, Versions, Publish, Migrate). A `deleteStructure` mutation exists in the hook but is never wired to any UI — that's why nothing happens.
- **Underlying delete is unsafe.** Current FKs:
  - `employee_contracts.salary_structure_id` → **SET NULL** (a delete silently unlinks live contracts — employees keep working but their contract loses its structure reference)
  - `payroll_rule_traces.structure_id` → SET NULL
  - `salary_components`, `payroll_salary_rules`, `salary_structure_rule_sets` → CASCADE (published historical snapshots would be wiped — an audit and legal problem)
- **RLS is fine** — `hr:write` grants both UPDATE and DELETE. This is purely a UI/lifecycle gap.

## How SAP, Workday, Oracle HCM handle this

Common pattern across enterprise payroll (SAP HCM Pay Scale / SuccessFactors Compensation, Workday Compensation Package, Oracle HCM Grade Structures):

1. **Metadata vs computation split.** Name, code, description, effective flag are metadata — freely editable in place. Rates, formulas, brackets are computation — only editable through a **new effective-dated version** (which we already model with `salary_structure_rule_sets` + Publish).
2. **Lifecycle states, not delete.** `draft → active → archived (inactive) → deleted`. "Archive" is the safe everyday action. Hard delete is admin-only and blocked while any dependency exists.
3. **Deletion preflight.** Before allowing hard delete the system enumerates blockers and shows them: assigned employees, in-flight payroll runs, historical payslips referencing any published version.
4. **Rename is always allowed** but historical payslips snapshot the structure name at run time, so past documents stay accurate.
5. **All lifecycle transitions are audited** (who, when, from → to state, reason).

## Mapping to our system — proposed lifecycle

```text
                         (Publish version)          (Archive)             (admin, no refs)
  [ Draft/Active ] ──────► [ Locked/Frozen ] ─────► [ Archived ] ─────────► [ Hard delete ]
      ▲                       (has versions)         is_active=false          (row removed)
      │                                                    │
      └──────────── (Reactivate) ──────────────────────────┘
```

Rules:
- **Rename / edit description / toggle active** — always allowed, always audited. Historical payslips already store the name they were computed under, so past documents remain correct.
- **Edit components / rates** — only allowed while the structure has **zero published rule set versions** (matches existing "frozen" chip). Once frozen, changes go through Publish → new version.
- **Archive (`is_active = false`)** — the everyday "delete". Structure is hidden from the "assign to contract" picker but stays queryable for history. Reversible.
- **Hard delete** — allowed only when **all** of the following are true:
  - No `employee_contracts` reference (active or historical)
  - No `payslips` computed against any of its published versions
  - No `payroll_runs` currently in `draft`/`processing` referencing it via any employee
  - Structure is already `is_active = false`
  - Caller has `hr:admin` (a step above `hr:write`)

## Scope of the implementation

### Step 1 — Server: enforce contract-blocking on delete
Migration:
- Change `employee_contracts.salary_structure_id` FK from `ON DELETE SET NULL` → `ON DELETE RESTRICT`. Contracts (past or present) referencing a structure must block hard delete. SET NULL is the silent-orphan bug.
- Add `salary_structures.archived_at TIMESTAMPTZ NULL`. `is_active=false` remains the query flag; `archived_at` is the audit timestamp.
- Add `salary_structure_lifecycle_events` table (event, from_state, to_state, actor, reason, occurred_at). RLS: read via `hr:read`, insert only via SECURITY DEFINER RPCs below. GRANTs per public-schema rules.

### Step 2 — Server: lifecycle RPCs
Three SECURITY DEFINER RPCs, all authorization-checked, all writing lifecycle events:

- `rename_salary_structure(p_id uuid, p_name text, p_code text, p_description text)` — metadata-only edit, allowed in any state, requires `hr:write`.
- `archive_salary_structure(p_id uuid, p_reason text)` — sets `is_active=false`, `archived_at=now()`. Requires `hr:write`.
- `restore_salary_structure(p_id uuid)` — reverse of archive.
- `delete_salary_structure(p_id uuid)` — preflight function that:
  1. Requires `hr:admin`.
  2. Returns a typed row of blockers: `{ contract_count int, payslip_count int, active_run_count int, is_archived boolean }`. If any blocker is non-zero or the structure isn't archived, RAISE with a structured message the UI renders as an actionable checklist.
  3. Otherwise deletes. CASCADE still cleans components, rules, and rule sets — but by that point no payslip references them because the preflight guarantees it.

A read-only helper `salary_structure_deletion_report(p_id uuid)` returns the same blocker shape without deleting — used by the UI to render the "you can't delete this because…" panel before the user clicks anything destructive.

### Step 3 — UI: `useSalaryStructures.ts`
- Add `renameStructure`, `archiveStructure`, `restoreStructure`, `deleteStructure` mutations, each calling the corresponding RPC via `supabase.rpc`. Optimistic updates for metadata; invalidate + refetch for state transitions.
- Add `useSalaryStructureDeletionReport(structureId)` query that only runs when the delete dialog is open.

### Step 4 — UI: `SalaryStructures.tsx` StructureCard
- **Edit button** (pencil icon) → opens a Sheet with Name, Code, Description, Active toggle. Save calls `renameStructure`. Available in all states.
- **Archive / Restore button** — flips based on `is_active`. Confirmation dialog explains "Archived structures stay in history but can't be assigned to new contracts."
- **Delete button** — only visible when `is_active=false` AND caller has `hr:admin`. Opens a preflight dialog that renders the `deletion_report`:
  - Green checks for satisfied requirements
  - Red rows with counts and quick-links for each blocker (e.g. "3 employee contracts still reference this — Reassign contracts →")
  - Delete button disabled until every row is green; requires typing the structure name to confirm (SAP-style hard-delete guard).
- **Lifecycle history** — small "History" popover on the card showing the last N `salary_structure_lifecycle_events` entries.

### Step 5 — Guard tests
- `src/test/architecture/salary-structure-lifecycle.test.ts` — greps `useSalaryStructures.ts` for all four mutations and asserts the delete path calls the RPC (never a raw `.from().delete()`).
- pgTAP `supabase/tests/salary_structure_delete_blocked_test.sql` — creates a structure with a contract, asserts `delete_salary_structure` fails with the blocker message; removes the contract, asserts it succeeds.
- pgTAP `supabase/tests/salary_structure_rename_test.sql` — asserts rename works while frozen (has published versions) and writes a lifecycle event.

## Explicitly out of scope

- Effective-dated versioning of the **metadata** itself (SAP-style pay scale reorg with a valid-from date on the name). Our historical payslips already snapshot names at compute time, so metadata-versioning would be additional complexity without a payroll-integrity payoff for the current stack.
- Bulk reassignment tool for "move all contracts from structure A to B" (implied by the "Reassign contracts →" quick-link) — that's a standalone follow-up screen.
- Approval workflow on lifecycle transitions (SAP GRC-style dual control). Can be layered on `approval_workflows` later if the user wants it.

## Technical notes

- All RPCs are SECURITY DEFINER with `SET search_path = public` and check `user_has_module_permission` explicitly — no reliance on RLS from inside the function.
- Deletion preflight runs in a REPEATABLE READ transaction so a payslip can't be created between the check and the delete.
- The FK change from SET NULL → RESTRICT is safe because Step 2 requires archival + zero refs before delete; existing rows with `salary_structure_id IS NOT NULL` are untouched.
- Lifecycle events feed the same table that could later back a Salary Structures operational cockpit (Phase 8 in the audit) — no rework needed.
