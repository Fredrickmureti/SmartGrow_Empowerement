/**
 * LandedCostRowActions — the Landed Costs list row menu.
 *
 * It renders `useLandedCostActions`, the exact array the record page header
 * and the peek render, so a voucher offers the same verbs wherever you meet
 * it. Row-local entries are "View details" (peek) and "Open full page".
 *
 * The full record (components, scope, allocations) is only fetched once the
 * row is armed — hovering or focusing the menu — so a list of vouchers costs
 * one query, not one per row. Until it lands, lifecycle actions that depend
 * on charge lines stay disabled with a plain reason.
 */
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { Eye, ExternalLink } from "lucide-react";

import { DocumentActionsMenu, type DocumentAction } from "@/design-system/records";
import {
  useLandedCostRecord,
  type LandedCostRecord,
  type LandedCostVoucherRow,
} from "./useLandedCosts";
import { useLandedCostActions } from "./useLandedCostActions";

interface Props {
  voucher: LandedCostVoucherRow;
  onPeek: (id: string) => void;
  onChanged?: () => void;
}

export function LandedCostRowActions({ voucher, onPeek, onChanged }: Props) {
  const navigate = useNavigate();
  const [armed, setArmed] = useState(false);
  const { record, refresh } = useLandedCostRecord(armed ? voucher.id : null);

  // Before the detail query lands we still know the voucher itself, so the
  // menu renders with the right lifecycle shape immediately.
  const effective: LandedCostRecord =
    record ?? { voucher, components: [], scope: [], allocations: [] };

  const { actions, dialogs } = useLandedCostActions(effective, {
    onChanged: () => {
      refresh();
      onChanged?.();
    },
    onDeleted: () => onChanged?.(),
  });

  const rowActions: DocumentAction[] = [
    {
      id: "view-details",
      label: "View details",
      icon: Eye,
      group: "peek",
      onSelect: () => onPeek(voucher.id),
    },
    {
      id: "open-full-page",
      label: "Open full page",
      icon: ExternalLink,
      group: "peek",
      onSelect: () => navigate(`/purchases/landed-costs/${voucher.id}`),
    },
    ...actions.map((a) =>
      !record && (a.id === "allocate" || a.id === "post")
        ? { ...a, disabled: true, disabledReason: "Loading voucher details…" }
        : a,
    ),
  ];

  const arm = () => setArmed(true);

  return (
    <div
      onClick={(e) => e.stopPropagation()}
      onMouseEnter={arm}
      onFocusCapture={arm}
      onPointerDown={arm}
    >
      <DocumentActionsMenu actions={rowActions} />
      {dialogs}
    </div>
  );
}

export default LandedCostRowActions;
