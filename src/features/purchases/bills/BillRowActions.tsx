/**
 * BillRowActions — the Bills list row menu.
 *
 * It renders `useBillActions`, the exact array the Bill record page header
 * renders, so a bill offers the same verbs wherever you meet it. The only
 * row-local entry is "View details", which opens the peek — a list affordance
 * that has no meaning on the full page.
 *
 * The hook is instantiated per row so each row owns its own dialog state
 * (payment, payment history, void). Do not re-introduce hand-rolled
 * DropdownMenuItems here: divergence between this menu and the record page
 * is exactly the bug this component exists to prevent.
 */
import { Eye } from "lucide-react";

import { DocumentActionsMenu, type DocumentAction } from "@/design-system/records";
import type { Bill } from "@/hooks/useBills";
import { useBillActions } from "./useBillActions";

interface BillRowActionsProps {
  bill: Bill;
  onPeek: (id: string) => void;
  onChanged?: () => void;
}

export function BillRowActions({ bill, onPeek, onChanged }: BillRowActionsProps) {
  const { actions, dialogs } = useBillActions(bill, { onChanged });

  const viewDetails: DocumentAction = {
    id: "view-details",
    label: "View details",
    icon: Eye,
    group: "peek",
    onSelect: () => onPeek(bill.id),
  };

  return (
    <>
      <DocumentActionsMenu actions={[viewDetails, ...actions]} />
      {dialogs}
    </>
  );
}

export default BillRowActions;
