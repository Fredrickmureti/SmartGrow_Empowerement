/**
 * useVendorCreditNoteActions — the single declaration of what you can do to
 * a Vendor Credit Note, shared by the record page header and the list row
 * menu (src/pages/VendorCreditNotes.tsx).
 *
 * ADR 0132 Phase 3: the commercial lifecycle (draft → submitted → approved /
 * rejected / cancelled) is distinct from the accounting one (unposted →
 * posted → reversed) and from settlement. Every transition is a server
 * command; the browser decides nothing about money or governance.
 */
import { useMemo } from "react";
import { useNavigate } from "react-router-dom";
import {
  Ban,
  CheckCircle,
  FileText,
  Pencil,
  RotateCcw,
  Send,
  ThumbsUp,
  Trash2,
  XCircle,
} from "lucide-react";

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
  /**
   * ADR 0132 Phase 4 — opens the reversal sheet. Reversal is never invoked
   * straight from a menu item: it is only ever entered through intent +
   * consequence preview, so the rules cannot drift between call sites.
   */
  onReverse?: () => void;
}

export function useVendorCreditNoteActions(
  cn: VendorCreditNote | null | undefined,
  { onChanged, onDeleted, onReverse }: Options = {},
) {
  const navigate = useNavigate();
  const { toast } = useToast();
  const {
    confirmVendorCreditNote,
    deleteVendorCreditNote,
    applyCreditFifo,
    submitVendorCreditNote,
    approveVendorCreditNote,
    rejectVendorCreditNote,
    cancelVendorCreditNote,
  } = useVendorCreditNotes();

  return useMemo<DocumentAction[]>(() => {
    if (!cn) return [];
    const commercial = cn.commercial_status ?? (cn.status === "draft" ? "draft" : "approved");
    const accounting =
      cn.accounting_status ?? (cn.status === "draft" ? "unposted" : cn.status === "void" ? "reversed" : "posted");
    const isDraft = commercial === "draft" || commercial === "rejected";
    const isSubmitted = commercial === "submitted";
    const unposted = accounting === "unposted";
    const posted = accounting === "posted";
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
        disabled: !(isDraft && unposted),
        disabledReason:
          isDraft && unposted
            ? undefined
            : "Only a draft credit note can be edited.",
        onSelect: () => navigate(`/purchases/credit-notes/${cn.id}/edit`),
      },
      {
        id: "submit",
        label: "Submit for approval",
        icon: Send,
        group: "core",
        primary: isDraft && unposted,
        hidden: !(isDraft && unposted),
        onSelect: run("Credit note submitted", () => submitVendorCreditNote(cn.id)),
      },
      {
        id: "approve",
        label: "Approve",
        icon: ThumbsUp,
        group: "core",
        primary: isSubmitted,
        hidden: !isSubmitted,
        onSelect: run("Credit note approved", () => approveVendorCreditNote(cn.id)),
      },
      {
        id: "reject",
        label: "Reject",
        icon: XCircle,
        group: "core",
        destructive: true,
        hidden: !isSubmitted,
        onSelect: () => {
          const reason = window.prompt(
            `Why is ${cn.credit_note_number} being rejected?`,
          );
          if (reason === null) return;
          run("Credit note rejected", () =>
            rejectVendorCreditNote(cn.id, reason || undefined),
          )();
        },
      },
      {
        id: "confirm",
        label: "Post to GL",
        icon: CheckCircle,
        group: "core",
        primary: commercial === "approved" && unposted,
        hidden: !unposted || commercial === "cancelled" || commercial === "rejected",
        onSelect: run("Credit note posted", () => confirmVendorCreditNote(cn.id)),
      },
      {
        id: "apply-to-bill",
        label: "Apply to bills",
        icon: FileText,
        group: "core",
        primary: posted && open > 0,
        hidden: !posted || open <= 0,
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
        id: "cancel",
        label: "Cancel",
        icon: Ban,
        destructive: true,
        hidden: posted || commercial === "cancelled",
        onSelect: () => {
          const reason = window.prompt(
            `Cancel credit note ${cn.credit_note_number}? Add a reason (optional).`,
          );
          if (reason === null) return;
          run("Credit note cancelled", () =>
            cancelVendorCreditNote(cn.id, reason || undefined),
          )();
        },
      },
      {
        id: "reverse",
        label: "Reverse",
        icon: RotateCcw,
        destructive: true,
        hidden: !posted || !onReverse,
        onSelect: () => onReverse?.(),
      },
      {
        id: "delete",
        label: "Delete",
        icon: Trash2,
        destructive: true,
        hidden: !(isDraft && unposted),
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
  }, [cn, navigate, onReverse]);
}

