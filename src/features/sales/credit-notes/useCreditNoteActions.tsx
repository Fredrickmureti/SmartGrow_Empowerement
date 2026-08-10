/**
 * useCreditNoteActions — the single declaration of what you can do to a
 * customer Credit Note, rendered identically by the list row menu and the
 * record page.
 */
import { useMemo } from "react";
import { useNavigate } from "react-router-dom";
import {
  Ban,
  CreditCard,
  Download,
  Edit,
  FileSearch,
  Mail,
  Printer,
  Send,
  Trash2,
} from "lucide-react";

import type { DocumentAction } from "@/design-system/records";
import { useDocumentPreview } from "@/components/documents/DocumentPreviewProvider";
import { useRecordPrint } from "@/features/sales/record/useRecordPrint";
import { useDocumentEmail } from "@/features/sales/record/useDocumentEmail";
import { useCreditNotes, type CreditNote } from "@/hooks/useCreditNotes";
import { useToast } from "@/hooks/use-toast";
import { normalizeError } from "@/services/resilience";

interface Options {
  onChanged?: () => void;
  onDeleted?: () => void;
  /** Where Apply / Refund should return to. */
  returnTo?: string;
}

export function useCreditNoteActions(
  creditNote:
    | (CreditNote & { contact?: { name?: string; email?: string | null } | null })
    | null
    | undefined,
  { onChanged, onDeleted, returnTo = "/sales/credit-notes" }: Options = {},
) {
  const navigate = useNavigate();
  const { toast } = useToast();
  const { preview } = useDocumentPreview();
  const { print, printing } = useRecordPrint("credit_note");
  const { issueCreditNote, updateCreditNote, deleteCreditNote } = useCreditNotes();
  const { send, dialog } = useDocumentEmail(onChanged);

  const actions = useMemo<DocumentAction[]>(() => {
    const cn = creditNote;
    if (!cn) return [];
    const status = cn.status as string;
    const isDraft = status === "draft";
    const hasRemaining = (cn.total ?? 0) > (cn.amount_applied ?? 0);
    const isIssued = status === "issued";

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
        icon: Edit,
        group: "core",
        primary: true,
        hidden: !isDraft,
        onSelect: () => navigate(`/sales/credit-notes/${cn.id}/edit`),
      },
      {
        id: "issue",
        label: "Issue credit note",
        icon: Send,
        group: "core",
        primary: isDraft,
        hidden: !isDraft,
        onSelect: run("Credit note issued", () => issueCreditNote(cn.id)),
      },
      {
        id: "apply",
        label: "Apply to invoice",
        icon: CreditCard,
        group: "money",
        primary: isIssued && hasRemaining,
        hidden: !(isIssued && hasRemaining),
        onSelect: () =>
          navigate(
            `/finance/customer-credits/${cn.id}/apply?returnTo=${encodeURIComponent(returnTo)}`,
          ),
      },
      {
        id: "refund",
        label: "Process refund",
        icon: Download,
        group: "money",
        hidden: !(isIssued && hasRemaining),
        onSelect: () =>
          navigate(
            `/finance/customer-credits/${cn.id}/refund?returnTo=${encodeURIComponent(returnTo)}`,
          ),
      },
      {
        id: "preview",
        label: "Preview",
        icon: FileSearch,
        group: "output",
        onSelect: () =>
          preview({
            documentType: "credit_note",
            documentId: cn.id,
            title: `Credit Note ${cn.credit_note_number}`,
            filename: `credit-note-${cn.credit_note_number}`,
          }),
      },
      {
        id: "print",
        label: "Print credit note",
        icon: Printer,
        group: "output",
        disabled: printing,
        onSelect: () =>
          void print(cn.id, `Credit Note ${cn.credit_note_number}`),
      },
      {
        id: "email",
        label: "Send via email",
        icon: Mail,
        group: "output",
        onSelect: () =>
          send({
            documentType: "credit_note",
            documentId: cn.id,
            documentNumber: cn.credit_note_number,
            recipientEmail: cn.contact?.email || "",
            recipientName: cn.contact?.name || "",
            total: cn.total,
            currency: cn.currency || undefined,
          } as never),
      },
      {
        id: "void",
        label: "Void credit note",
        icon: Ban,
        destructive: true,
        hidden: isDraft || status === "void",
        onSelect: run("Credit note voided", () =>
          updateCreditNote(cn.id, { status: "void" } as never),
        ),
      },
      {
        id: "delete",
        label: "Delete",
        icon: Trash2,
        destructive: true,
        hidden: !isDraft,
        onSelect: () => {
          void (async () => {
            try {
              await deleteCreditNote(cn.id);
              toast({ title: "Credit note deleted" });
              onDeleted?.();
            } catch (error: unknown) {
              toast({
                title: "Error deleting",
                description: normalizeError(error).message,
                variant: "destructive",
              });
            }
          })();
        },
      },
    ];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [creditNote, printing, navigate, preview, print, send, returnTo]);

  return { actions, dialogs: dialog };
}
