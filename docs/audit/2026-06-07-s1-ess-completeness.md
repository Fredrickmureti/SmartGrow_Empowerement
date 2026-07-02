# Audit: Phase 2 / Slice S1 — Employee Self-Service Portal Completeness

**Date:** 2026-06-07  
**Scope:** `/me/*` routes (MeApp) + `EmployeeSelfService` legacy shell  
**Method:** Static analysis — actual source, migrations, edge-function inventory  

---

## 1. Profile Edit Save (`/me/profile`)

**Status: ⚠️ Partial**

`MyProfile.tsx` is a **redirect-only shell** — it immediately navigates to
`/hr/employees/<id>` (`MyProfile.tsx:24`).  The actual edit surface is
`EmployeeProfilePage` (`src/pages/hr/EmployeeProfile.tsx`).

### What works
- `EmployeeProfilePage` detects `isOwnProfile` (line 71) and sets `canEdit = true`.
- `handleSelfServiceUpdate` (line 127-134) filters edits through `SELF_SERVICE_FIELDS` when the
  user is not an HR manager.
- `SELF_SERVICE_FIELDS` (line 56-61): `avatar_url`, `emergency_contact_name`,
  `emergency_contact_phone`, `personal_phone`.
- RLS allows self-update: `employees_self_update` policy (`USING (user_id = auth.uid())`) —
  migration `20260215000712`.
- Avatar upload works via `EmployeeAvatarUpload` (canEdit=true in `EmployeeSelfService.tsx:289`).

### Gaps
- The profile tab inside `/me` (i.e., `EmployeeSelfService.tsx:298-313`) shows only **read-only**
  `<p>` tags — no edit controls at all. The `/me/profile` redirect lands on the full HR profile
  page which is more powerful than intended for pure portal users.
- Fields like `first_name`, `last_name`, `email`, `work_email` are **not** in
  `SELF_SERVICE_FIELDS`, so an employee cannot correct their own name or email.
- No "My Profile" edit form purpose-built for the `/me` shell.

### Smallest fix
- Add `first_name`, `last_name`, `personal_phone`, `work_email` to `SELF_SERVICE_FIELDS`
  (`EmployeeProfile.tsx:56`).
- Replace the read-only `<p>` grid in `EmployeeSelfService.tsx:298-313` with an editable
  `<Input>` form wired to `updateEmployee` / a dedicated `useProfileSelfUpdate` hook.
- No migration needed (RLS is already correct).

---

## 2. Payslip Download from Portal

**Status: ✅ Working**

- `/me/payslips` renders `EmployeeSelfService` (MeApp route `MeApp.tsx` line ~110).
- `EmployeeSelfService.tsx:142-158`: `handleDownloadPayslip` calls
  `supabase.functions.invoke("generate-payslip-pdf", { body: { payslip_id } })` and creates a
  Blob download link.
- Edge function `supabase/functions/generate-payslip-pdf/index.ts` exists.
- Payslip SELECT RLS: `employee_documents_select` (migration `20260504211259`) allows
  `e.user_id = auth.uid()` — employees can read their own rows.
- "View detail" (`<Eye>`) opens `PayslipDetailDialog` (line 378-381).
- Table-level CSV/XLSX export also present via `ReportExportButtons` (line 326-327).

### Minor gap
- Comment on line 15 says _"generation is now via generate-payroll-document"_, but the actual
  call (line 142) uses `generate-payslip-pdf`. Both functions exist; the comment is stale but
  functionality is correct.

---

## 3. Loan Request Form (`/me/loans`)

**Status: ✅ Working**

- `MyLoans.tsx:100` renders a `<Button onClick={() => setShowWizard(true)}>Request loan</Button>`.
- `RequestLoanWizard` is imported (`MyLoans.tsx:27`) and mounted at line 202.
- `useMyLoans.ts` `requestLoan` mutation inserts into `employee_loans` with `status='requested'`
  (line ~115 in hook).
- RLS `employee_loans_insert_self_request` (migration `20260606135759`):
  `status = 'requested' AND employee_id IN (SELECT id FROM employees WHERE user_id = auth.uid())`.
- Cancel of pending requests also works (line 160-163), backed by
  `employee_loans_update_self_request` policy (same migration).
- Advances are modeled as a loan type (`loan_type = 'advance'`/`repayment_method =
  'one_off_next_payroll'`); no separate `employee_advances` table exists — confirmed by schema
  search. The UI labels them "loans & advances" (`MyLoans.tsx:95`).

---

## 4. Advance Request

**Status: ✅ Working (via loan form)**

Advances are **not** a separate table — they use `employee_loans.loan_type = 'advance'` and
`repayment_method = 'one_off_next_payroll'` (`useMyLoans.ts` lines ~90-95). The wizard's loan
type list presumably includes an "advance" type managed by HR under Loan Types Settings. No
`employee_advances` table is created anywhere in migrations.

**Risk:** If no HR admin has configured a loan type with advance semantics, the wizard will show
no advance option. This is a configuration gap, not a code gap.

---

## 5. Document Acknowledgement (`/me/documents`)

**Status: ❌ Missing**

- `/me/documents` route renders `EmployeeSelfService` (`MeApp.tsx` lines ~115-120).
- `EmployeeSelfService.tsx` has **no "documents" tab** — the `<TabsList>` has only `profile`,
  `payslips`, and `leave` (lines 256-272). Routing to `/me/documents` opens the
  `EmployeeSelfService` page at the default tab (`profile`).
- The `employee_documents` table has no `acknowledged_at` or `acknowledgement` column (schema
  from migration `20260326174613` — columns: `id, organization_id, employee_id, document_type,
  name, description, file_path, file_name, file_size, mime_type, uploaded_by, expiry_date,
  is_verified, verified_by, verified_at, created_at, updated_at`).
- RLS was updated (migration `20260504211259`) to allow employees to SELECT their own documents
  via `e.user_id = auth.uid()`. There is **no INSERT or UPDATE** policy for employees on their
  own document rows.
- No `useMyDocuments` hook exists anywhere in `src/hooks/`.

### Smallest fix
- **Migration:** Add `acknowledged_at TIMESTAMPTZ` column to `employee_documents`. Add an RLS
  UPDATE policy allowing employees to set only `acknowledged_at` on their own rows.
- **Hook:** Create `src/hooks/hr/useMyDocuments.ts` — SELECT scoped to `currentEmployee.id`,
  plus a `acknowledge(id)` mutation.
- **Page:** Add a "Documents" tab to `EmployeeSelfService.tsx` (or a new `MyDocuments.tsx`)
  rendering a list with a checkbox/button to acknowledge; wire to the hook above.

---

## 6. Onboarding Task Completion (`/me/onboarding`)

**Status: ✅ Working**

- `MyOnboarding.tsx` fetches `employee_onboarding` + `employee_onboarding_items` for the current
  employee (lines 52-70).
- `toggleItem` (lines 77-90) does a direct `supabase.from("employee_onboarding_items").update()`
  with `is_completed` and `completed_at`.
- RLS `employee_onboarding_items_update_own` (migration `20260606144132`) permits UPDATE where
  the linked `employee.user_id = auth.uid()` — correct.
- UI renders a `<Checkbox>` per item (`MyOnboarding.tsx:205`), state is persisted on check.

**Minor gap:** The parent `employee_onboarding` record's `status` and `completed_at` are not
automatically updated when all items are ticked. The progress bar shows 100% but the badge still
reads the DB `status` field. A DB trigger or client-side patch after last item completion would
be needed to flip the parent to `completed`.

---

## 7. Exit Clearance Self-Service

**Status: ❌ Missing (admin-only)**

- No file exists under `src/pages/me/` for exit clearance.
- `rg "useExitClearance|exit_clearance"` returns zero hits in `src/`.
- `EmployeeProfile.tsx:92` shows the "Exit Clearance" tab is only rendered when
  `visible: canManageTeam` — hidden from portal users.
- The clearance workflow is admin-initiated (HR manager opens `EmployeeTerminationDialog`).
- No portal surface for an employee to view or sign off their own exit items.

### Smallest fix
- Create `src/pages/me/MyExitClearance.tsx` — query any `employee_onboarding` (or dedicated
  exit table) rows with `onboarding_type = 'offboarding'` belonging to the current employee.
- Add a `/me/exit` route in `MeApp.tsx`.
- If exit items are separate from onboarding, confirm the table name and add a matching
  `*_select_own` / `*_update_own` RLS policy. The existing `employee_onboarding_items_select_own`
  policy (migration `20260606144132`) may already cover offboarding rows if they share the same
  table — verify at implementation time.

---

## Prioritised Fix List

| Priority | Item | Rationale |
|----------|------|-----------|
| **P0** | **Document acknowledgement (item 5)** — missing feature + no `acknowledged_at` column | Compliance risk: contracts and policy docs may require legal acknowledgement. Also blocks HR audit trails. Requires migration + hook + UI. |
| **P1** | **Profile edit UI in `/me` shell (item 1)** | Employees cannot update emergency contacts from the portal without navigating to the full HR profile, which is confusing and sometimes inaccessible (non-admin portal users may lack HR module permission to even render that page). |
| **P1** | **Exit clearance self-service (item 7)** | Employees in offboarding have no portal surface to see or action their clearance tasks. HR must do everything manually. |
| **P2** | **Onboarding parent status auto-complete (item 6)** | Minor UX inconsistency — progress reaches 100% but badge still says "in progress" until HR manually closes. Add a trigger or a client-side PATCH to `employee_onboarding.status = 'completed'` when all items are ticked. |
| **P2** | **Stale comment in `EmployeeSelfService.tsx:15`** | References wrong function name (`generate-payroll-document` vs actual `generate-payslip-pdf`). No functional impact. |

