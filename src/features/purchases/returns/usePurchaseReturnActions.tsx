/**
 * usePurchaseReturnActions — the single declaration of what you can do to a
 * Purchase Return, shared by the record page header and the list row menu
 * (src/pages/PurchaseReturns.tsx).
 *
 * Every mutating action is a server command from
 * `@/lib/purchases/purchaseReturnRpcs` carrying the `row_version` we read, so a
 * stale tab fails loudly instead of overwriting. The action set is derived from
 * the lifecycle, not from optimism:
 *
 *   draft      → Edit, Submit, Cancel, (Delete via cancel — rows are never hard-deleted)
 *   submitted  → Approve / Reject (ungated path; a gated one is decided in the
 *                approvals inbox and mirrored back by the governance engine)
 *   approved   → Dispatch (the only place stock leaves the warehouse)
 *   dispatched → Acknowledge (supplier confirmed / RMA reference)
 *   ack'd      → Raise debit note (issues the vendor credit note + GL)
 *   credited   → Close
 *
 * Deliberately absent: any client-side status flip, stock movement, journal
 * line or debit-note insert. Those grants were revoked.
 */
import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  BadgeCheck,
  CheckCircle,
  Download,
  FileSearch,
  FileText,
  Mail,
  Pencil,
  Printer,
  Send,
  Truck,
  XCircle,
} from "lucide-react";

import type { DocumentAction } from "@/design-system/records";
import { useDocumentPreview } from "@/components/documents/DocumentPreviewProvider";
import { useRecordPrint } from "@/features/purchases/record/useRecordPrint";
import { useRecordDownload } from "@/features/purchases/record/useRecordDownload";
import { useDocumentEmail } from "@/features/purchases/record/useDocumentEmail";
import type { PurchaseReturn } from "@/hooks/usePurchaseReturns";
import { useSubscriptionAccess } from "@/contexts/SubscriptionAccessContext";
import { useToast } from "@/hooks/use-toast";
import { normalizeError } from "@/services/resilience";
import {
  acknowledgePurchaseReturn,
  approvePurchaseReturn,
  cancelPurchaseReturn,
  closePurchaseReturn,
  dispatchPurchaseReturn,
  raisePurchaseReturnCredit,
  rejectPurchaseReturn,
  submitPurchaseReturn,
} from "@/lib/purchases/purchaseReturnRpcs";
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
}

type PromptKind = "reject" | "cancel" | "dispatch" | "acknowledge" | null;

export function usePurchaseReturnActions(
  pr:
    | (PurchaseReturn & { vendor?: { name: string; email?: string | null } | null })
    | null
    | undefined,
  { onChanged }: Options = {},
) {
  const navigate = useNavigate();
  const { toast } = useToast();
  const { preview } = useDocumentPreview();
  const { print, printing } = useRecordPrint("purchase_return");
  const { download, downloading } = useRecordDownload("purchase_return");
  const { isReadOnly, openUpgradeModal } = useSubscriptionAccess();
  const { send, dialog: emailDialog } = useDocumentEmail(onChanged);
  const [prompt, setPrompt] = useState<PromptKind>(null);
  const [promptValue, setPromptValue] = useState("");

  const actions = useMemo<DocumentAction[]>(() => {
    if (!pr) return [];
    const status = pr.status as string;
    const version = pr.row_version ?? 0;
    // Legacy rows created before the lifecycle rebuild still carry "pending".
    const isDraft = status === "draft" || status === "pending";

    const guarded = (fn: () => void) => () => {
      if (isReadOnly) {
        openUpgradeModal("purchase_returns");
        return;
      }
      fn();
    };

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
        primary: false,
        disabled: !isDraft,
        disabledReason: isDraft ? undefined : "Only draft returns can be edited.",
        onSelect: () => navigate(`/purchases/returns/${pr.id}/edit`),
      },
      {
        id: "submit",
        label: "Submit for approval",
        icon: Send,
        group: "core",
        primary: isDraft,
        hidden: !isDraft,
        onSelect: guarded(() => {
          void (async () => {
            try {
              const res = await submitPurchaseReturn(pr.id, version);
              toast({
                title: res?.gated
                  ? "Sent for approval"
                  : "Submitted — awaiting approval",
                description: res?.gated
                  ? "An approver must decide in the approvals inbox."
                  : undefined,
              });
              onChanged?.();
            } catch (error: unknown) {
              toast({
                title: "Submit failed",
                description: normalizeError(error).message,
                variant: "destructive",
              });
            }
          })();
        }),
      },
      {
        id: "approve",
        label: "Approve",
        icon: CheckCircle,
        group: "core",
        primary: status === "submitted",
        hidden: status !== "submitted",
        onSelect: guarded(
          run("Purchase return approved", () => approvePurchaseReturn(pr.id, version)),
        ),
      },
      {
        id: "reject",
        label: "Reject",
        icon: XCircle,
        group: "core",
        destructive: true,
        hidden: status !== "submitted",
        onSelect: guarded(openPrompt("reject")),
      },
      {
        id: "dispatch",
        label: "Dispatch to supplier",
        icon: Truck,
        group: "core",
        primary: status === "approved",
        hidden: status !== "approved",
        onSelect: guarded(openPrompt("dispatch")),
      },
      {
        id: "acknowledge",
        label: "Supplier acknowledged",
        icon: BadgeCheck,
        group: "core",
        primary: status === "dispatched",
        hidden: status !== "dispatched",
        onSelect: guarded(openPrompt("acknowledge")),
      },
      {
        id: "raise-credit",
        label: pr.vendor_credit_note_id ? "Debit note raised" : "Raise debit note",
        icon: FileText,
        group: "core",
        primary: status === "acknowledged" && !pr.vendor_credit_note_id,
        hidden:
          !!pr.vendor_credit_note_id ||
          !["acknowledged", "dispatched"].includes(status),
        onSelect: guarded(
          run("Vendor debit note raised", () => raisePurchaseReturnCredit(pr.id, version)),
        ),
      },
      {
        id: "close",
        label: "Close return",
        icon: CheckCircle,
        group: "core",
        primary: status === "credited",
        hidden: status !== "credited",
        onSelect: guarded(run("Purchase return closed", () => closePurchaseReturn(pr.id, version))),
      },
      {
        id: "preview",
        label: "Preview",
        icon: FileSearch,
        group: "output",
        onSelect: () =>
          preview({
            documentType: "purchase_return",
            documentId: pr.id,
            title: `Purchase Return ${pr.return_number}`,
            filename: `purchase-return-${pr.return_number}`,
          }),
      },
      {
        id: "email",
        label: "Email to supplier",
        icon: Mail,
        group: "output",
        hidden: !pr.vendor_id,
        onSelect: () =>
          send({
            documentType: "credit_note" as never,
            documentId: pr.id,
            documentNumber: pr.return_number,
            recipientEmail: pr.vendor?.email ?? "",
            recipientName: pr.vendor?.name ?? "",
            total: pr.total,
            currency: pr.currency ?? undefined,
          }),
      },
      {
        id: "print",
        label: printing ? "Generating…" : "Print",
        icon: Printer,
        group: "output",
        disabled: printing,
        onSelect: () => void print(pr.id, `Return ${pr.return_number}`),
      },
      {
        id: "download",
        label: downloading ? "Preparing…" : "Download PDF",
        icon: Download,
        group: "output",
        disabled: downloading,
        onSelect: () => void download(pr.id, `purchase-return-${pr.return_number}`),
      },
      {
        id: "cancel",
        label: "Cancel return",
        icon: XCircle,
        destructive: true,
        hidden: !["draft", "pending", "submitted", "approved", "rejected"].includes(status),
        onSelect: guarded(openPrompt("cancel")),
      },
    ];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pr, printing, downloading, isReadOnly, navigate, preview, print, download, send]);

  const promptCopy: Record<Exclude<PromptKind, null>, {
    title: string;
    description: string;
    label: string;
    placeholder: string;
    required: boolean;
    confirm: string;
  }> = {
    reject: {
      title: "Reject this return",
      description:
        "The return goes back to the requester as rejected. The reason is written to the audit trail.",
      label: "Rejection reason",
      placeholder: "e.g. Supplier disputes the fault — resolve with QA first",
      required: true,
      confirm: "Reject",
    },
    cancel: {
      title: "Cancel this return",
      description:
        "Cancelling closes the document without moving stock or raising a debit note.",
      label: "Cancellation reason",
      placeholder: "Optional",
      required: false,
      confirm: "Cancel return",
    },
    dispatch: {
      title: "Dispatch to supplier",
      description:
        "This is the moment stock leaves the warehouse: the server writes the outbound stock movements against the returned lots.",
      label: "Tracking reference",
      placeholder: "Optional carrier / consignment reference",
      required: false,
      confirm: "Dispatch",
    },
    acknowledge: {
      title: "Record supplier acknowledgement",
      description:
        "Confirms the supplier received the goods. Capture their RMA reference so the debit note can quote it.",
      label: "RMA reference",
      placeholder: "Optional supplier RMA number",
      required: false,
      confirm: "Record acknowledgement",
    },
  };

  const submitPrompt = () => {
    if (!pr || !prompt) return;
    const value = promptValue.trim();
    const version = pr.row_version ?? 0;
    const action =
      prompt === "reject"
        ? { label: "Purchase return rejected", fn: () => rejectPurchaseReturn(pr.id, version, value) }
        : prompt === "cancel"
          ? { label: "Purchase return cancelled", fn: () => cancelPurchaseReturn(pr.id, version, value || null) }
          : prompt === "dispatch"
            ? {
                label: "Return dispatched — stock released",
                fn: () =>
                  dispatchPurchaseReturn({
                    id: pr.id,
                    rowVersion: version,
                    trackingReference: value || null,
                  }),
              }
            : {
                label: "Supplier acknowledgement recorded",
                fn: () =>
                  acknowledgePurchaseReturn({
                    id: pr.id,
                    rowVersion: version,
                    rmaReference: value || null,
                  }),
              };

    void (async () => {
      try {
        await action.fn();
        toast({ title: action.label });
        setPrompt(null);
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

  const copy = prompt ? promptCopy[prompt] : null;

  return {
    actions,
    dialogs: (
      <>
        {emailDialog}
        <AlertDialog open={!!prompt} onOpenChange={(open) => !open && setPrompt(null)}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>{copy?.title}</AlertDialogTitle>
              <AlertDialogDescription>{copy?.description}</AlertDialogDescription>
            </AlertDialogHeader>
            <div className="space-y-2">
              <Label>{copy?.label}</Label>
              <Input
                value={promptValue}
                placeholder={copy?.placeholder}
                onChange={(e) => setPromptValue(e.target.value)}
              />
            </div>
            <AlertDialogFooter>
              <AlertDialogCancel>Back</AlertDialogCancel>
              <AlertDialogAction
                disabled={!!copy?.required && promptValue.trim().length === 0}
                onClick={(e) => {
                  e.preventDefault();
                  submitPrompt();
                }}
              >
                {copy?.confirm}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </>
    ),
  };
}
