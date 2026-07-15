## Scope

Two independent, presentation-only fixes. No RLS, RPC, or business-logic changes.

---

## 1. Employee Self-Service — Tax certificates: Download button is disabled

### Root cause

`src/pages/me/MyTaxCertificates.tsx` renders one Download button per row and disables it when `!cert.pdf_path`:

```tsx
disabled={!cert.pdf_path || downloadingId === cert.id}
```

The current-generation ("v3") certificates carry **no server-rendered PDF** — `pdf_path` is `null` by design. Their human-readable artifact is an HTML file in `cert.artifacts[]` that the browser paginates and prints via `printCertificateHtml` (see `downloadTaxCertificate` in `src/hooks/payroll/useTaxCertificates.ts`, lines 480–512). That is exactly what the business workspace page `src/pages/hr/payroll/TaxCertificates.tsx` does (lines 624–676): it iterates over `cert.artifacts` and renders one action per artifact, calling `downloadTaxCertificate({ artifact_path, format: "html" })` for HTML (opens the browser print dialog) and `downloadTaxCertificate(cert, "xlsx" | "pdf")` for the rest.

The ESS page never looked at `artifacts`, so for every v3 certificate the Download button is dead.

### Fix (presentation only, in `src/pages/me/MyTaxCertificates.tsx`)

- Replace the single `disabled={!cert.pdf_path}` button with the same artifact-driven action cluster the business page uses, restricted to the artifacts an employee is meant to consume: `html` (rendered as "Print"), `pdf` ("Download PDF"), `xlsx` ("Download Excel"). Skip `gov_*` artifacts — those are for filers, not employees.
- Fall back to synthesising an artifact list from `pdf_path` / `xlsx_path` scalars for pre-migration rows (same shim as the business page).
- Disable actions when `cert.stale` is true, with the same tooltip copy ("Regenerate this certificate before downloading the current file").
- Keep the existing per-row spinner (`downloadingId`) but track it per artifact so a Print click doesn't grey out the sibling Excel button.
- No hook, RPC, or edge-function change — `downloadTaxCertificate` already handles the HTML → `printCertificateHtml` path.

### Verification

- `bun x vitest run src/test/architecture/me-uses-design-system.test.ts` — the page keeps `PageHeader` + `PageBody`; no new dialog imports.
- Manual: on `/me/tax-certificates`, an issued certificate now shows a "Print" (HTML) action that opens the browser print dialog, matching the business workspace behaviour.

---

## 2. Resource Center — no way back to the workspace

### Root cause

In `src/App.tsx` (lines 282–283), `/resources` and `/resources/:id` are declared as standalone protected routes — they are **not** wrapped in the workspace layout (sidebar + topbar) the rest of the signed-in app uses. As a result:

- `/resources/:id` header only exposes a "Library" button → `/resources`.
- `/resources` header has no back button at all.
- Once a user follows the topbar "Resources" action into this section, the only way back to the workspace is the browser back button.

The pages themselves live in `src/pages/resources/*` and just render `PageHeader` + `PageBody` — they assume a chrome that isn't there.

### Fix (presentation only)

Add a persistent "Back to workspace" affordance in both Resource Center pages' `PageHeader.actions` slot, and refine the detail page so the primary back action is the parent workspace, with "Library" kept as a secondary link.

`src/pages/resources/ResourcesIndex.tsx`:
- Add `actions` on `PageHeader`: `<Button variant="outline" asChild><Link to="/home"><ArrowLeft /> Back to workspace</Link></Button>`.

`src/pages/resources/ResourceDetail.tsx`:
- Replace the single "Library" action with an `ActionBar` containing two buttons:
  1. `Back to workspace` → `/home` (primary variant `outline`, with `ArrowLeft`).
  2. `Library` → `/resources` (variant `ghost`, keeps the existing quick hop).
- Also update the `EmptyState` "Video not found" action to include the same "Back to workspace" button alongside "Back to library".

Route target is `/home` — the same landing the app's topbar logo points at for signed-in users (matches the rest of the app's "return to shell" convention; no router/layout refactor).

Out of scope for this pass: moving the Resource Center inside the workspace shell layout. That is a larger router change (would need `MainLayout` wrapping + tenant/business context guards) and the user asked for the navigation to be reachable, not for a layout re-parenting.

### Verification

- Manual: from `/resources` and `/resources/:id`, the header shows a "Back to workspace" button that returns the user to the workspace shell in one click.

---

## Files touched

- `src/pages/me/MyTaxCertificates.tsx` — artifact-driven action cluster mirroring the business workspace.
- `src/pages/resources/ResourcesIndex.tsx` — add "Back to workspace" in header actions.
- `src/pages/resources/ResourceDetail.tsx` — add "Back to workspace" alongside "Library" in header + empty state.

No migrations, no edge-function changes, no hook changes.
