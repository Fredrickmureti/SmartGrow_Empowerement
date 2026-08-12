/**
 * VendorCreditNoteRowActions — the Vendor Credit Notes list row menu.
 *
 * It renders `useVendorCreditNoteActions`, the exact array the record page
 * header renders, so a credit note offers the same verbs (submit, approve,
 * reject, dispute, post, apply, preview/print/download/email, cancel, delete)
 * wherever you meet it. The only row-local entry is "View details", which
 * opens the peek — a list affordance with no meaning on the full page.
 *
 * The hook is instantiated per row so each row owns its own dialog state.
 * Do not re-introduce hand-rolled DropdownMenuItems or a list-local apply
 * dialog here: divergence between this menu and the record page — and
 * client-side allocation of credit — is exactly what this component prevents.
 */
import { Eye } from "lucide-react";

import { DocumentActionsMenu, type DocumentAction } from "@/design-system/records";
import type { VendorCreditNote } from "@/hooks/useVendorCreditNotes";
import { useVendorCreditNoteActions } from "./useVendorCreditNoteActions";

interface VendorCreditNoteRowActionsProps {
  creditNote: VendorCreditNote & {
    vendor?: { name?: string | null; email?: string | null } | null;
  };
  onPeek: (id: string) => void;
  onChanged?: () => void;
}

export function VendorCreditNoteRowActions({
  creditNote,
  onPeek,
  onChanged,
}: VendorCreditNoteRowActionsProps) {
  const { actions, dialog } = useVendorCreditNoteActions(creditNote, { onChanged });

  const viewDetails: DocumentAction = {
    id: "view-details",
    label: "View details",
    icon: Eye,
    group: "peek",
    onSelect: () => onPeek(creditNote.id),
  };

  return (
    <>
      <DocumentActionsMenu actions={[viewDetails, ...actions]} />
      {dialog}
    </>
  );
}

export default VendorCreditNoteRowActions;
