/**
 * useDeliveryNoteActions — the single declaration of what you can do to a
 * Delivery Note, rendered identically by the list row menu and the record
 * page. Dispatch, POD and partial-delivery capture stay on
 * `DeliveryLogisticsPanel` (they need a form); this hook covers the
 * one-click lifecycle + output actions.
 */
import { useMemo } from "react";
import {
  CheckCircle,
  FileSearch,
  Mail,
  Navigation,
  Printer,
  XCircle,
} from "lucide-react";

import type { DocumentAction } from "@/design-system/records";
import { useDocumentPreview } from "@/components/documents/DocumentPreviewProvider";
import { useDocumentEmail } from "@/features/sales/record/useDocumentEmail";
import { usePrintDeliveryNote } from "./usePrintDeliveryNote";
import { useDeliveryNotes, type DeliveryNote } from "@/hooks/useDeliveryNotes";
import { useMarkDeliveryReady, useCompleteDelivery } from "@/hooks/useDeliveryLifecycle";
import { isFinalDeliveryStatus } from "@/types/deliveryNote";
import { useToast } from "@/hooks/use-toast";
import { normalizeError } from "@/services/resilience";

interface Options {
  onChanged?: () => void;
}

type Row = DeliveryNote & {
  contact?: { name?: string | null; email?: string | null } | null;
};

export function useDeliveryNoteActions(
  note: Row | null | undefined,
  { onChanged }: Options = {},
) {
  const { toast } = useToast();
  const { preview } = useDocumentPreview();
  const printDeliveryNote = usePrintDeliveryNote();
  const { cancelDelivery } = useDeliveryNotes();
  const markReady = useMarkDeliveryReady(note?.id ?? null);
  const completeDelivery = useCompleteDelivery(note?.id ?? null);
  const { send, dialog } = useDocumentEmail(onChanged);

  const actions = useMemo<DocumentAction[]>(() => {
    if (!note) return [];
    const status = note.status as string;
    const isFinal = isFinalDeliveryStatus(status);
    const isPending = status === "pending";
    const isReadyOrPending = status === "pending" || status === "ready_to_dispatch";
    const canComplete = status !== "delivered" && status !== "partial" && status !== "cancelled";

    return [
      {
        id: "mark-ready",
        label: "Mark ready to dispatch",
        icon: Navigation,
        group: "core",
        primary: isPending,
        hidden: !isPending,
        onSelect: () => markReady.mutate(note.id, { onSuccess: onChanged }),
      },
      {
        id: "complete",
        label: "Complete delivery",
        icon: CheckCircle,
        group: "core",
        primary: isReadyOrPending && canComplete,
        hidden: !canComplete,
        onSelect: () =>
          completeDelivery.mutate({ id: note.id }, { onSuccess: onChanged }),
      },
      {
        id: "preview",
        label: "Preview",
        icon: FileSearch,
        group: "output",
        onSelect: () =>
          preview({
            documentType: "delivery_note",
            documentId: note.id,
            title: `Delivery Note ${note.delivery_number}`,
            filename: `delivery-note-${note.delivery_number}`,
          }),
      },
      {
        id: "print",
        label: "Print",
        icon: Printer,
        group: "output",
        onSelect: () =>
          void printDeliveryNote({ id: note.id, delivery_number: note.delivery_number }),
      },
      {
        id: "email",
        label: "Send via email",
        icon: Mail,
        group: "output",
        onSelect: () =>
          send({
            documentType: "delivery_note",
            documentId: note.id,
            documentNumber: note.delivery_number,
            recipientEmail: note.contact?.email || "",
            recipientName: note.contact?.name || "",
            total: 0,
            currency: undefined,
          } as never),
      },
      {
        id: "cancel",
        label: "Cancel delivery",
        icon: XCircle,
        destructive: true,
        hidden: isFinal,
        onSelect: () =>
          void (async () => {
            try {
              await cancelDelivery(note.id, null);
              onChanged?.();
            } catch (error: unknown) {
              toast({
                title: "Error cancelling delivery",
                description: normalizeError(error).message,
                variant: "destructive",
              });
            }
          })(),
      },
    ];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [note, preview, send, printDeliveryNote, markReady, completeDelivery, cancelDelivery, onChanged]);

  return { actions, dialogs: dialog };
}
