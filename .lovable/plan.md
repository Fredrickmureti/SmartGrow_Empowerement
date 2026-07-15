
# Employee Identity & Lifecycle — Architectural Audit + Remediation

You asked for an audit before code. This plan splits the work into a **read-only audit deliverable** (Phase 0), a **surgical fix of the two blocking RPCs against the existing, correct architecture** (Phase 1), and a **structural follow-up** driven by whatever Phase 0 uncovers (Phase 2+). No code is written until you approve.

## What I already know from the codebase

Before proposing anything I traced the two failing paths:

- **`get_linkable_users_for_employee`** (`supabase/migrations/20260608215047_*.sql`) — SECURITY DEFINER function, gated on `hr.write`, returns `(user_id, display_name, email_masked, linkability, block_reason)`. Ambiguity source: the CTE `linked_elsewhere` and CTE `pa` both project a column literally named `user_id`, and the outer SELECT references them as `IN (SELECT user_id FROM linked_elsewhere)` / `IN (SELECT user_id FROM pa)`. Postgres cannot decide whether that inner `user_id` binds to the CTE column or to the outer RETURN TABLE column `user_id`. This is a **local SQL defect inside a correct architecture**, not an architectural flaw. The design intent (server-side classification, masked email, HR-permission gate, block reasons for owners/admins/platform-admins/self) is sound.
- **`upsert_organization_invitation`** (`supabase/migrations/20260613005759_*.sql`) — The `INSERT` passes `p_permission_group_ids` (may be `NULL`, e.g. portal invites where the caller correctly sends `null`) into `organization_invitations.permission_group_ids` which is `NOT NULL DEFAULT '{}'`. The RPC ignores its own default. This is also a **local defect**: the column is legitimately NOT NULL (portals must not carry groups, internals must have an explicit selection or fall back to the "Internal Users" system group at accept-time — the `accept_organization_invitation_atomic` function already implements that fallback). The invitation writer just needs to COALESCE.

Neither defect argues for merging Employee and User, changing the invitation model, or reworking permission groups. Both are bug-level and the surrounding architecture (Employee → Invitation → Auth user → `user_roles` + `member_permission_groups` → optional `employees.user_id` back-link, with `accept_organization_invitation_atomic` as the single atomic acceptor and `prevent_portal_group_assignment` guarding portal isolation) is Odoo/Workday-shaped and defensible.

## Phase 0 — Audit deliverable (no code)

I will produce a single markdown document at `docs/architecture/employee-identity-lifecycle.md` covering the 17 items you listed. Concretely it contains:

1. **Current architecture diagram** (Mermaid): tables `employees`, `organization_invitations`, `auth.users`, `profiles`, `user_roles`, `permission_groups`, `member_permission_groups`, `user_business_access`, `user_branch_assignments`, `employee_lifecycle_events`, `employee_position_history`, `employee_compensation_history`, `platform_admins`, and the FKs / trigger web between them.
2. **Intended architecture diagram** — same shape, with any gaps highlighted (candidates I already suspect: no explicit `employee_identity` bridge table, so `employees.user_id` is doing double duty as both "who is this employee in auth" and "employee is currently linkable"; `user_access_status` on `employees` overlaps with derived state from `user_roles.is_active`).
3. **Lifecycle diagram** (state machine): draft → active → invited → linked/portal → linked/internal → on-leave → transferred → terminated → reactivated, with the write that drives each transition and the guard trigger enforcing it.
4. **Business event map**: for every RowAction (View / Invite / Link / Set Manager / Transfer / Change Compensation / Deactivate / Terminate / Reactivate / Delete) I record: the RPC or edge fn, the tables it writes, the audit trail row it produces, the permission it requires, and the reverse operation.
5. **Enterprise comparison** (Workday / SuccessFactors / Oracle HCM / Dynamics / Odoo): one paragraph each on how they separate Worker/Person/User, and where our model already matches vs where it diverges. I'll cite the concrete divergences, not marketing copy.
6. **Identified flaws** — from the trace, not guesses. Early candidates: (a) `employees.user_access_status` is a denormalised mirror of state that lives in `user_roles`/`organization_invitations`, and it's updated from three separate call sites (`EmployeeInviteDialog`, `accept-invitation` edge fn, `accept_organization_invitation_atomic`) — one source of truth needed; (b) invitation acceptance auto-links by `lower(email)` match, which silently binds the wrong `Employee` when two employees share an email or when HR fixes an email typo after inviting; (c) no `employee_identity_events` audit projection distinct from `employee_lifecycle_events` — invite/link/unlink events aren't first-class; (d) `get_linkable_users_for_employee` blocks owners/admins from ever being linked to their own employee record, which is arguably wrong for owner-founders.
7. **Recommendations, DB / API / UI / security / permission / invitation / linking changes, migration + backward-compat strategy, risk analysis, implementation plan** — each as its own section, tied back to the flaws in (6). Nothing speculative.

Deliverable is a single reviewable doc. You read it and either approve Phase 1 as scoped below, or you send me back to redraft.

## Phase 1 — Unblock the two RPCs (only after Phase 0 is approved)

Both are one-migration fixes against the existing design. No table changes, no policy changes, no UI changes.

- **`get_linkable_users_for_employee`**: rename the CTE columns (`linked_elsewhere.linked_user_id`, `pa.admin_user_id`) so the `IN (...)` sub-selects are unambiguous; keep every other line — the gate, the classification, the mask, the block reasons — identical. Add a pgTAP test that (a) runs the RPC as an HR user and asserts it returns rows without error, (b) asserts owner / platform-admin / internal / self / cross-linked are each classified correctly.
- **`upsert_organization_invitation`**: `COALESCE(p_permission_group_ids, ARRAY[]::uuid[])` on the INSERT path and on the UPDATE path; keep the semantics that portal invites pass `null` from the UI and land as `{}`, and internal invites pass the selected group ids. Add a pgTAP test covering: portal invite with null, internal invite with `{}`, internal invite with a real group, reused pending invite that swaps user_type portal↔internal.

Both migrations are `CREATE OR REPLACE FUNCTION`, so rollback is redeploying the previous body. No downtime, no data migration.

## Phase 2 — Structural follow-ups (scope confirmed after Phase 0 review)

Only the items you approve from the audit. Likely candidates, in priority order:

1. Collapse `employees.user_access_status` into a **view** derived from `user_roles` + `organization_invitations` state, and remove the three write sites.
2. Replace the "auto-link by email at accept time" step in `accept_organization_invitation_atomic` with an **explicit `employee_invitation_id` FK on `organization_invitations`** written by `EmployeeInviteDialog`, so link-on-accept is deterministic. Migrate existing pending invites by best-effort email match at migration time and never again at runtime.
3. Promote invite / link / unlink into `employee_lifecycle_events` (or a new `employee_identity_events`) so the Employee timeline reflects identity changes uniformly with hire/transfer/terminate.
4. Reconsider whether owners/admins should be blockable link targets (product decision, not a bug).

Each item ships as its own migration + tests + UI wiring, gated on your approval per item.

## Technical details

- No changes to `auth.users`, `storage`, `realtime`, `supabase_functions`, or `vault`.
- Phase 1 migrations are `CREATE OR REPLACE FUNCTION` only — no `ALTER TABLE`, no policy churn, no `types.ts` change.
- Tests land in `supabase/tests/` (pgTAP) plus `src/test/architecture/` for the picker + invite dialog contract tests already in the repo.
- The existing arch tests `hr-configuration-shell.test.ts` and `no-direct-employee-user-link.test.ts` remain green — the RPC name and shape are preserved.

## Explicitly out of scope until you say otherwise

Merging Employee and User; removing `permission_group_ids`; changing how portal vs internal is decided; replacing `accept_organization_invitation_atomic`; touching `platform_admins`; anything in Payroll/Time-Off/Attendance beyond what the Employee timeline reads.
