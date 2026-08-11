---
name: Document action parity (Purchases)
description: Row menus, peeks and record pages must all render the same use<Doc>Actions array; Preview/Print/Download are distinct verbs
type: feature
---

Every purchases document exposes exactly one action vocabulary through its
`use<Doc>Actions` hook (`src/features/purchases/<doc>/use*Actions.tsx`).

- List row menus render it via `DocumentActionsMenu` (see `BillRowActions`,
  `PurchaseOrderRowActions`). Hand-rolled `DropdownMenuItem` row menus are
  forbidden — guarded by
  `src/test/architecture/document-workspace-canonical.test.ts`.
- Record pages render the same array through `RecordScaffold actions`.
- Preview, Print and Download are three separate actions, never collapsed
  into one "Print / Preview" item. Download goes through
  `useRecordDownload` (`downloadExport`), print through `useRecordPrint`.
- A document can only be previewed/printed/downloaded if it has a snapshot
  builder registered in `resolveSourceDocumentRecord`. Vendor credit notes
  have none yet, so they carry no output actions.
- Bills: the approval ladder (submit → approve/reject → post to ledger) is
  in the hook; "Post to ledger" only shows on `approved`, or on `draft` when
  the org does not require bill approval.
