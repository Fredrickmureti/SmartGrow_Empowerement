# Fix `/hr/employees/new` to match the enterprise form standard

## Why it looks "weird"

Every other create route in the ERP (Contacts, Finance accounts, Bank accounts, etc.) now goes through `src/design-system/primitives/RecordFormShell.tsx`, which owns:

- the `RecordHeader` (eyebrow "New record" + title `New <Entity>`)
- the `<form>` element
- the `FooterActionBar` (Cancel leading, primary submit trailing, optional `extraLeadingActions` slot for things like "Save as draft")
- the submitting / disabled state

`/hr/employees/new` (`src/pages/hr/EmployeeNewPage.tsx`) is the only remaining create route that does NOT use `RecordFormShell`. Instead it renders:

- a bespoke `page-header` with a back button + "Add Employee" title + paragraph
- a plain `<Card><CardContent>` wrapper
- `EmployeeFormDialog renderAs="page"`, which internally renders its own `<form>` plus its own inline footer (`Discard draft` / `Back` / `Save as draft` / `Create`).

Result: different header style, different footer style (not sticky, not left/right split), Card padding instead of the shell's spacing, no "New record" eyebrow, "Back" instead of "Cancel", inconsistent button ordering. That's the visual mismatch the user is seeing.

Scope of this change: **only** `/hr/employees/new`. The edit route (`/hr/employees/:id`) and the rest of HR are out of scope for this turn.

## Plan

### 1. Introduce a page-mode footer contract in `EmployeeFormDialog`

`EmployeeFormDialog` is shared by the dialog flow and the page flow, so we can't simply delete its footer. Add a minimal opt-out so the page can host the footer in `RecordFormShell` instead:

- Add prop `hideInlineFooter?: boolean` (default `false`).
- When `renderAs === "page"` and `hideInlineFooter` is true:
  - Do not render the inline `<div className="pt-4 border-t">{footerActions}</div>` block inside the `<form>`.
  - Expose the individual action handlers/state via new render props or a `footerSlots` object passed through a new prop `onRenderFooter?: (slots) => void` — simpler: export the small pieces the page needs (submit is already handled via `form="employee-form-body"`; page needs `Save as draft`, `Discard draft`, `hasSavedDraft`, `isSavingDraft`, `isSubmitting`).
- Concretely, add a `footerController?: { current: EmployeeFooterApi | null }` ref-style prop, OR (cleaner) split the tiny action bits into a new prop callback `onFooterState?: (state) => void` that the page uses to drive the shell's `extraLeadingActions` / `extraTrailingActions`.

Chosen approach (least invasive): add `hideInlineFooter` + `onFooterState` callback that fires whenever `{ hasSavedDraft, isSavingDraft, isSubmitting, canSaveDraft }` changes, plus expose imperative `saveAsDraft()` / `discardDraft()` via a forwarded ref. The page wires those to `RecordFormShell`.

If the ref approach adds too much surface area, fall back to lifting the two callbacks (`onSaveAsDraft`, `onDiscardDraft`) — which the page already owns — and re-using them from the page's footer buttons directly. The dialog still renders its inline footer for `renderAs="dialog"`. This is the simplest path and is what will be implemented.

### 2. Rewrite `src/pages/hr/EmployeeNewPage.tsx` on `RecordFormShell`

- Remove the `page-header` block, the back button, the `<Card>` wrapper.
- Remove the local `AlertDialog` "Leave without saving?" — `EmployeeFormDialog` already ships its own discard-guard and the page-level guard duplicates it; keep the `useUnsavedChangesGuard` hook and keep a single guard driven from the shell's Cancel.
- Render:

```tsx
<RecordFormShell
  mode="create"
  entityLabel="Employee"
  cancelHref="/hr/employees"
  onSubmit={(e) => { e.preventDefault(); formRef.current?.requestSubmit(); }}
  isSubmitting={isSubmitting}
  submitLabel="Create Employee"
  extraLeadingActions={
    hasSavedDraft ? (
      <Button variant="ghost" className="text-destructive" onClick={handleDiscardDraft}>
        Discard draft
      </Button>
    ) : null
  }
  extraTrailingActions={
    <Button variant="secondary" onClick={handleSaveDraft} disabled={isSavingDraft || isSubmitting}>
      Save as draft
    </Button>
  }
>
  <EmployeeFormDialog
    renderAs="page"
    hideInlineFooter
    open
    onOpenChange={...}
    editingEmployee={null}
    onSubmit={handleSubmit}
    onSaveAsDraft={...}
    onDirtyChange={setDirty}
    onSubmittingChange={setIsSubmitting}
    onDraftStateChange={({ hasSavedDraft, isSavingDraft }) => { ... }}
    draftId={draftId}
    onDiscardDraft={...}
  />
</RecordFormShell>
```

- The shell's primary Submit button uses `form={formId}` internally. `EmployeeFormDialog`'s inner form has id `employee-form-body`. Two options:
  1. Have the page's submit handler call `document.getElementById('employee-form-body').requestSubmit()` — brittle.
  2. Add an `formId?: string` prop to `EmployeeFormDialog` so the page can pass the shell's generated form id in, and drop the inner `<form>` in favor of using the shell's `<form>`.

Option 2 is the correct enterprise fix: the shell owns the `<form>`. Add `formId` prop; when provided in `renderAs="page"`, `EmployeeFormDialog` renders its body inside a plain `<div>` and stops rendering its own `<form>`. Submit is triggered by the shell's Submit button, which is already `type="submit" form={formId}`. `handleSubmit` (the internal submit handler) is exposed via a new `onSubmitAttempt` that the page forwards to `RecordFormShell.onSubmit`.

Cleanest concrete API changes to `EmployeeFormDialog` for page mode:
- `hideInlineFooter?: boolean`
- `hideInlineForm?: boolean` — when true, do not render the wrapping `<form>` (submit is owned by the shell).
- `onSubmittingChange?: (b: boolean) => void`
- `onDraftStateChange?: (s: { hasSavedDraft: boolean; isSavingDraft: boolean }) => void`

The page uses `onSubmittingChange` + `onDraftStateChange` to feed `RecordFormShell.isSubmitting` and to conditionally render `Discard draft` / `Save as draft`. The page's `RecordFormShell.onSubmit` calls the same `handleSubmit(form)` logic the dialog was calling internally; expose that as a callback `onFormSubmit(formData) => Promise<void>` (already the existing `onSubmit` prop — reuse it).

### 3. Retire the duplicate leave-guard AlertDialog

`EmployeeFormDialog` already renders `discardGuard` internally. The page-level `AlertDialog` in `EmployeeNewPage` is dead weight once the shell owns Cancel — `useUnsavedChangesGuard` still catches route changes / tab close, so keep the hook but let the dialog's own guard cover the Cancel button click (since Cancel routes back via `navigate(-1)`, the hook intercepts it).

### 4. Verify

- Manual visual check via Playwright: navigate to `/hr/employees/new`, screenshot header + footer, compare to `/contacts-app/new` and one Finance create route. They should be structurally identical (eyebrow + title, sticky footer with Cancel on the left and Create Employee on the right, `Save as draft` + `Discard draft` sitting in the extra slots).
- Regression check: `/hr/employees` list "Add employee" button still routes here; edit route unchanged; dialog mode of `EmployeeFormDialog` (used elsewhere, if any) still renders its own form + footer.
- `rg "EmployeeFormDialog"` to confirm no other caller breaks from the new opt-in props (all default to `false`).

### 5. Out of scope

- No changes to `/hr/employees/:id` (edit), other HR pages, other apps.
- No changes to the underlying save RPCs, draft logic, or `EmployeeFormTabContents`.
- The 949-line `EmployeeFormDialog` is not being split up in this pass; only the four opt-in props above are added.

## Files touched

- `src/pages/hr/EmployeeNewPage.tsx` — rewritten on `RecordFormShell`.
- `src/components/employees/EmployeeFormDialog.tsx` — add `hideInlineFooter`, `hideInlineForm`, `onSubmittingChange`, `onDraftStateChange`; gate the inline `<form>` and inline footer on those flags. Dialog mode unchanged.
