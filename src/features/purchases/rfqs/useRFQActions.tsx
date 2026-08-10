/**
 * useRFQActions — the single declaration of what you can do to an RFQ,
 * shared by the record page header and any row menu that adopts it.
 */
import { useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { Ban, FileText, Pencil, Send, Trash2 } from "lucide-react";

import type { DocumentAction } from "@/design-system/records";
import { useRFQs, type RFQ } from "@/hooks/useRFQs";

interface Options {
  onDeleted?: () => void;
}

export function useRFQActions(
  rfq: RFQ | null | undefined,
  { onDeleted }: Options = {},
) {
  const navigate = useNavigate();
  const { updateStatus, deleteRFQ } = useRFQs();

  return useMemo<DocumentAction[]>(() => {
    if (!rfq) return [];
    const status = rfq.status as string;
    const isDraft = status === "draft";

    return [
      {
        id: "edit",
        label: "Edit",
        icon: Pencil,
        group: "core",
        primary: true,
        hidden: !isDraft,
        onSelect: () => navigate(`/purchases/rfqs/${rfq.id}/edit`),
      },
      {
        id: "mark-sent",
        label: "Mark sent",
        icon: Send,
        group: "core",
        primary: isDraft,
        hidden: !isDraft,
        onSelect: () => updateStatus({ id: rfq.id, status: "sent" }),
      },
      {
        id: "mark-received",
        label: "Mark received",
        icon: FileText,
        group: "core",
        primary: status === "sent",
        hidden: status !== "sent",
        onSelect: () => updateStatus({ id: rfq.id, status: "received" }),
      },
      {
        id: "cancel",
        label: "Cancel",
        icon: Ban,
        destructive: true,
        hidden: !["draft", "sent", "received"].includes(status),
        onSelect: () => updateStatus({ id: rfq.id, status: "cancelled" }),
      },
      {
        id: "delete",
        label: "Delete",
        icon: Trash2,
        destructive: true,
        hidden: !isDraft,
        confirm: {
          title: `Delete RFQ ${rfq.rfq_number}?`,
          description: "This permanently removes the draft RFQ.",
          confirmLabel: "Delete",
        },
        onSelect: () => {
          deleteRFQ(rfq.id);
          onDeleted?.();
        },
      },
    ];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rfq, navigate]);
}
