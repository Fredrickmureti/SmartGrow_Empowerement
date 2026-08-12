/**
 * useVendorCreditNoteActions — the single declaration of what you can do to
 * a Vendor Credit Note, shared by the record page header and the list row
 * menu (src/pages/VendorCreditNotes.tsx).
 *
 * ADR 0132 Phase 3: the commercial lifecycle (draft → submitted → approved /
 * rejected / disputed / cancelled) is distinct from the accounting one
 * (unposted → posted → reversed) and from settlement. Every transition is a
 * server command; the browser decides nothing about money or governance.
 *
 * ADR 0132 Phase 5: the note is a document in its own right
 * (`purchases.credit_note`), so Preview / Print / Download / Email render the
 * SAME frozen snapshot through the one renderer, and every reason-bearing
 * transition is captured in a structured dialog rather than `window.prompt`
 * — reasons land in the audit trail and must be legible there.
 */
import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  Ban,
  CheckCircle,
  Download,
  FileSearch,
  FileText,
  Gavel,
  Mail,
  Pencil,
  Printer,
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
import { useDocumentPreview } from "@/components/documents/DocumentPreviewProvider";
import { useRecordPrint } from "@/features/purchases/record/useRecordPrint";
import { useRecordDownload } from "@/features/purchases/record/useRecordDownload";
import { useDocumentEmail } from "@/features/purchases/record/useDocumentEmail";
import { useToast } from "@/hooks/use-toast";
import { normalizeError } from "@/services/resilience";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

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

type PromptKind = "reject" | "cancel" | "dispute" | "apply" | "delete" | null;

const PROMPT_COPY: Record<
  Exclude<PromptKind, null>,
  {
    title: string;
    description: string;
    label?: string;
    placeholder?: string;
    required?: boolean;
    confirm: string;
  }
> = {
  reject: {
    title: "Reject this credit note",
    description:
      "Rejection is our own decision: the claim goes back to the raiser as rejected. The reason is written to the audit trail.",
    label: "Rejection reason",
    placeholder: "e.g. The overbilling was already settled on the last statement",
    required: true,
    confirm: "Reject",
  },
  dispute: {
    title: "Supplier disputes this credit note",
    description:
      "A dispute records that the counterparty refuses the claim. Nothing posts to the ledger while a note is in dispute; resolve it once the supplier accepts or we withdraw.",
    label: "What is the supplier disputing?",
    placeholder: "e.g. Supplier says the goods were signed for in full",
    required: true,
    confirm: "Mark disputed",
  },
  cancel: {
    title: "Cancel this credit note",
    description:
      "Cancelling closes the claim without posting anything. A posted note must be reversed instead.",
    label: "Cancellation reason",
    placeholder: "Optional",
    required: false,
    confirm: "Cancel credit note",
  },
  apply: {
    title: "Apply this credit to open bills",
    description:
      "The server allocates the open credit across this supplier's outstanding bills, oldest first, and writes the matching credit movements.",
    confirm: "Apply oldest first",
  },
  delete: {
    title: "Delete this credit note",
    description:
      "Only an unposted draft can be deleted. Nothing is written to the ledger, and the number is not reused.",
    confirm: "Delete",
  },
};

export function useVendorCreditNoteActions(
  cn:
    | (VendorCreditNote & { vendor?: { name?: string | null; email?: string | null } | null })
    | null
    | undefined,
  { onChanged, onDeleted, onReverse }: Options = {},
) {
  const navigate = useNavigate();
  const { toast } = useToast();
  const { preview } = useDocumentPreview();
  const { print, printing } = useRecordPrint("vendor_credit_note");
  const { download, downloading } = useRecordDownload("vendor_credit_note");
  const { send, dialog: emailDialog } = useDocumentEmail(onChanged);
  const [prompt, setPrompt] = useState<PromptKind>(null);
  const [promptValue, setPromptValue] = useState("");
  const {
    confirmVendorCreditNote,
    deleteVendorCreditNote,
    applyCreditFifo,
    submitVendorCreditNote,
    approveVendorCreditNote,
    rejectVendorCreditNote,
    cancelVendorCreditNote,
    disputeVendorCreditNote,
    resolveVendorCreditNoteDispute,
  } = useVendorCreditNotes();

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

  const actions = useMemo<DocumentAction[]>(() => {
    if (!cn) return [];
    const commercial = cn.commercial_status ?? (cn.status === "draft" ? "draft" : "approved");
    const accounting =
      cn.accounting_status ??
      (cn.status === "draft" ? "unposted" : cn.status === "void" ? "reversed" : "posted");
    const isDraft = commercial === "draft" || commercial === "rejected";
    const isSubmitted = commercial === "submitted";
    const isDisputed = commercial === "disputed";
    const unposted = accounting === "unposted";
    const posted = accounting === "posted";
    const open = (cn.total ?? 0) - (cn.amount_applied ?? 0);

    const openPrompt = (kind: PromptKind) => () => {
      setPromptValue("");
      setPrompt(kind);
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
          isDraft && unposted ? undefined : "Only a draft credit note can be edited.",
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
        onSelect: openPrompt("reject"),
      },
      {
        id: "dispute",
        label: "Supplier disputes",
        icon: Gavel,
        group: "core",
        hidden: isDisputed || posted || !(isSubmitted || commercial === "approved"),
        onSelect: openPrompt("dispute"),
      },
      {
        id: "dispute-accepted",
        label: "Supplier accepted — resume",
        icon: CheckCircle,
        group: "core",
        primary: isDisputed,
        hidden: !isDisputed,
        onSelect: run("Dispute resolved", () =>
          resolveVendorCreditNoteDispute(cn.id, "accepted"),
        ),
      },
      {
        id: "dispute-withdrawn",
        label: "Withdraw the claim",
        icon: Ban,
        group: "core",
        destructive: true,
        hidden: !isDisputed,
        onSelect: run("Claim withdrawn", () =>
          resolveVendorCreditNoteDispute(cn.id, "withdrawn"),
        ),
      },
      {
        id: "confirm",
        label: "Post to GL",
        icon: CheckCircle,
        group: "core",
        primary: commercial === "approved" && unposted,
        hidden:
          !unposted ||
          isDisputed ||
          commercial === "cancelled" ||
          commercial === "rejected",
        onSelect: run("Credit note posted", () => confirmVendorCreditNote(cn.id)),
      },
      {
        id: "apply-to-bill",
        label: "Apply to bills",
        icon: FileText,
        group: "core",
        primary: posted && open > 0,
        hidden: !posted || open <= 0,
        onSelect: openPrompt("apply"),
      },
      {
        id: "preview",
        label: "Preview",
        icon: FileSearch,
        group: "output",
        onSelect: () =>
          preview({
            documentType: "vendor_credit_note",
            documentId: cn.id,
            title: `Vendor Credit Note ${cn.credit_note_number}`,
            filename: `vendor-credit-note-${cn.credit_note_number}`,
          }),
      },
      {
        id: "email",
        label: "Email to supplier",
        icon: Mail,
        group: "output",
        hidden: !cn.vendor_id,
        onSelect: () =>
          send({
            documentType: "vendor_credit_note",
            documentId: cn.id,
            documentNumber: cn.credit_note_number,
            recipientEmail: cn.vendor?.email ?? "",
            recipientName: cn.vendor?.name ?? "",
            total: cn.total,
            currency: cn.currency ?? undefined,
          }),
      },
      {
        id: "print",
        label: printing ? "Generating…" : "Print",
        icon: Printer,
        group: "output",
        disabled: printing,
        onSelect: () => void print(cn.id, `Credit note ${cn.credit_note_number}`),
      },
      {
        id: "download",
        label: downloading ? "Preparing…" : "Download PDF",
        icon: Download,
        group: "output",
        disabled: downloading,
        onSelect: () => void download(cn.id, `vendor-credit-note-${cn.credit_note_number}`),
      },
      {
        id: "cancel",
        label: "Cancel",
        icon: Ban,
        destructive: true,
        hidden: posted || commercial === "cancelled" || isDisputed,
        onSelect: openPrompt("cancel"),
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
        onSelect: openPrompt("delete"),
      },
    ];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cn, printing, downloading, navigate, preview, print, download, send, onReverse]);

  const copy = prompt ? PROMPT_COPY[prompt] : null;
  const blocked = !!copy?.required && promptValue.trim().length === 0;

  const confirmPrompt = () => {
    if (!cn || !prompt) return;
    const reason = promptValue.trim() || undefined;
    const kind = prompt;
    setPrompt(null);
    if (kind === "reject") {
      run("Credit note rejected", () => rejectVendorCreditNote(cn.id, reason))();
    } else if (kind === "dispute") {
      run("Marked as disputed", () => disputeVendorCreditNote(cn.id, reason))();
    } else if (kind === "cancel") {
      run("Credit note cancelled", () => cancelVendorCreditNote(cn.id, reason))();
    } else if (kind === "apply") {
      run("Credit applied", () => applyCreditFifo(cn.id))();
    } else if (kind === "delete") {
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
    }
  };

  const dialog = (
    <>
      {emailDialog}
      <AlertDialog open={prompt !== null} onOpenChange={(o) => !o && setPrompt(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{copy?.title}</AlertDialogTitle>
            <AlertDialogDescription>{copy?.description}</AlertDialogDescription>
          </AlertDialogHeader>
          {copy?.label ? (
            <div className="space-y-2">
              <Label htmlFor="vcn-prompt-reason">{copy.label}</Label>
              <Input
                id="vcn-prompt-reason"
                value={promptValue}
                placeholder={copy.placeholder}
                onChange={(e) => setPromptValue(e.target.value)}
              />
            </div>
          ) : null}
          <AlertDialogFooter>
            <AlertDialogCancel>Close</AlertDialogCancel>
            <AlertDialogAction disabled={blocked} onClick={confirmPrompt}>
              {copy?.confirm}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );

  return { actions, dialog };
}
