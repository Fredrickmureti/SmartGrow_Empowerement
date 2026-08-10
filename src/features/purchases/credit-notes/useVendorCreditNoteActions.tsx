/**
 * useVendorCreditNoteActions — the single declaration of what you can do to
 * a Vendor Credit Note, shared by the record page header and the list row
 * menu (src/pages/VendorCreditNotes.tsx).
 */
import { useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { CheckCircle, FileText, Pencil, Trash2 } from "lucide-react";

import type { DocumentAction } from "@/design-system/records";
import {
  useVendorCreditNotes,
  type VendorCreditNote,
} from "@/hooks/useVendorCreditNotes";
import { useToast } from "@/hooks/use-toast";
import { normalizeError } from "@/services/resilience";

interface Options {
  onChanged?: () => void;
  onDeleted?: () => void;
}

export function useVendorCreditNoteActions(
  cn: VendorCreditNote | null | undefined,
  { onChanged, onDeleted }: Options = {},
) {
  const navigate = useNavigate();
  const { toast } = useToast();
  const { confirmVendorCreditNote, deleteVendorCreditNote, applyCreditFifo } =
    useVendorCreditNotes();

  return useMemo<DocumentAction[]>(() => {
    if (!cn) return [];
    const status = cn.status as string;
    const isDraft = status === "draft";
    const open = (cn.total ?? 0) - (cn.amount_applied ?? 0);

    const run = (label: string, fn: () => Promise<unknown>) => () => {
      void (async () => {
        try {
          await fn();
          toast({ title: label });
          onChanged?.();
        } catch (error: unknown) {
          toast({
            title: "Action failed",
            description: normalizeError(error).message,
            variant: "destructive",
          });
        }
      })();
    };

    return [
      {
        id: "edit",
        label: "Edit",
        icon: Pencil,
        group: "core",
        primary: true,
        disabled: !isDraft,
        disabledReason: isDraft
          ? undefined
          : "A confirmed credit note can no longer be edited.",
        onSelect: () => navigate(`/purchases/credit-notes/${cn.id}/edit`),
      },
      {
        id: "confirm",
        label: "Confirm & post GL",
        icon: CheckCircle,
        group: "core",
        primary: isDraft,
        hidden: !isDraft,
        onSelect: run("Credit note confirmed", () =>
          confirmVendorCreditNote(cn.id),
        ),
      },
      {
        id: "apply-to-bill",
        label: "Apply to bills",
        icon: FileText,
        group: "core",
        primary: status === "confirmed",
        hidden: status !== "confirmed" || open <= 0,
        onSelect: () => {
          if (
            !window.confirm(
              `Apply the open credit on ${cn.credit_note_number} to this vendor's outstanding bills (oldest first)?`,
            )
          )
            return;
          run("Credit applied", () => applyCreditFifo(cn.id))();
        },
      },
      {
        id: "delete",
        label: "Delete",
        icon: Trash2,
        destructive: true,
        hidden: !isDraft,
        onSelect: () => {
          if (!window.confirm(`Delete credit note ${cn.credit_note_number}?`))
            return;
          void (async () => {
            try {
              await deleteVendorCreditNote(cn.id);
              toast({ title: "Credit note deleted" });
              onDeleted?.();
            } catch (error: unknown) {
              toast({
                title: "Error deleting credit note",
                description: normalizeError(error).message,
                variant: "destructive",
              });
            }
          })();
        },
      },
    ];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cn, navigate]);
}
