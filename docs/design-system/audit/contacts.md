# Contacts Module — Design System Audit

_Status snapshot after Wave 12 (Contacts routed record form)._

| Surface | Status | File(s) |
| --- | --- | --- |
| Contacts list (All / Customers / Vendors / Companies) | Done | `src/pages/Contacts.tsx` |
| Contact create workspace | Done | `src/features/contacts/ContactCreatePage.tsx` → `RecordFormShell` |
| Contact edit workspace | Done | `src/features/contacts/ContactEditPage.tsx` → `RecordFormShell` |
| Shared record form body | Done | `src/features/contacts/ContactRecordForm.tsx` |
| Contact 360° profile | Done | `src/pages/contacts/ContactProfile.tsx` |
| Delete / Archive confirm | Done (≤6-field confirm) | `src/components/contacts/ContactDeleteDialog.tsx` |
| Merge utility | Done (workflow utility) | `src/components/contacts/ContactMergeDialog.tsx` |
| Bulk update / bulk delete | Done (workflow utility) | `src/components/contacts/ContactBulkActions.tsx`, `src/components/common/BulkDeleteDialog.tsx` |
| Customer groups admin | Done (workflow utility) | `src/components/contacts/CustomerGroupsDialog.tsx` |

## Notes

- Wave 12 retired the ~340-line inline `<Dialog>` in `Contacts.tsx` and replaced it with routed workspaces at `/contacts-app/new` and `/contacts-app/:id/edit`, mirroring the Finance (Journal Entry, Bank Account, Budget) and Sales (Invoice) treatment.
- Legacy deep links (`?action=create[&type=]`, `?action=edit&id=`) redirect transparently to the new routes so cross-module CTAs continue to work.
- Remaining `*Dialog` files in `src/components/contacts/` are confirm/workflow utilities (delete, merge, bulk update, groups admin) — they are ≤6 fields or operate on collections and are outside the record-form ban.