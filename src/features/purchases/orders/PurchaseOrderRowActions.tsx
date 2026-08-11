/**
 * PurchaseOrderRowActions — the Purchase Orders list row menu.
 *
 * Renders `usePurchaseOrderActions`, the same array the PO record page
 * header renders, so the list and the full page can never drift. "View
 * details" is the only row-local entry (it opens the peek).
 */
import { Eye } from "lucide-react";

import { DocumentActionsMenu, type DocumentAction } from "@/design-system/records";
import type { PurchaseOrder } from "@/hooks/usePurchaseOrders";
import { usePurchaseOrderActions } from "./usePurchaseOrderActions";

interface PurchaseOrderRowActionsProps {
  po: PurchaseOrder & { vendor?: { name: string; email?: string | null } | null };
  onPeek: (id: string) => void;
  onChanged?: () => void;
}

export function PurchaseOrderRowActions({
  po,
  onPeek,
  onChanged,
}: PurchaseOrderRowActionsProps) {
  const { actions, dialogs } = usePurchaseOrderActions(po, {
    onChanged,
    onDeleted: onChanged,
  });

  const viewDetails: DocumentAction = {
    id: "view-details",
    label: "View details",
    icon: Eye,
    group: "peek",
    onSelect: () => onPeek(po.id),
  };

  return (
    <>
      <DocumentActionsMenu actions={[viewDetails, ...actions]} />
      {dialogs}
    </>
  );
}

export default PurchaseOrderRowActions;
