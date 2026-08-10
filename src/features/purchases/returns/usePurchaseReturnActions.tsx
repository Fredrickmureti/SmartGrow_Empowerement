/**
 * usePurchaseReturnActions — the single declaration of what you can do to a
 * Purchase Return, shared by the record page header and any row menu that
 * adopts it (src/pages/PurchaseReturns.tsx).
 */
import { useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { CheckCircle, Mail, Pencil, Printer, Trash2, XCircle } from "lucide-react";

import type { DocumentAction } from "@/design-system/records";
import { useRecordPrint } from "@/features/purchases/record/useRecordPrint";
import { useDocumentEmail } from "@/features/purchases/record/useDocumentEmail";
import {
  usePurchaseReturns,
  type PurchaseReturn,
} from "@/hooks/usePurchaseReturns";
import { useSubscriptionAccess } from "@/contexts/SubscriptionAccessContext";
import { useToast } from "@/hooks/use-toast";
import { normalizeError } from "@/services/resilience";

interface Options {
  onChanged?: () => void;
  onDeleted?: () => void;
}

export function usePurchaseReturnActions(
  pr:
    | (PurchaseReturn & { vendor?: { name: string; email?: string | null } | null })
    | null
    | undefined,
  { onChanged, onDeleted }: Options = {},
) {
  const navigate = useNavigate();
  const { toast } = useToast();
  const { print, printing } = useRecordPrint("purchase_return");
  const { updatePurchaseReturn, deletePurchaseReturn } = usePurchaseReturns();
  const { isReadOnly, openUpgradeModal } = useSubscriptionAccess();
  const { send, dialog: emailDialog } = useDocumentEmail(onChanged);

  const actions = useMemo<DocumentAction[]>(() => {
    if (!pr) return [];
    const status = pr.status as string;
    const isPending = status === "pending";

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

    return [
      {
        id: "edit",
        label: "Edit",
        icon: Pencil,
        group: "core",
        primary: true,
        disabled: !isPending,
        disabledReason: isPending
          ? undefined
          : "Only pending returns can be edited.",
        onSelect: () => navigate(`/purchases/returns/${pr.id}/edit`),
      },
      {
        id: "approve",
        label: "Approve",
        icon: CheckCircle,
        group: "core",
        primary: isPending,
        hidden: !isPending,
        onSelect: guarded(
          run("Purchase return approved", () =>
            updatePurchaseReturn(pr.id, { status: "approved" }),
          ),
        ),
      },
      {
        id: "process",
        label: "Mark processed",
        icon: CheckCircle,
        group: "core",
        primary: status === "approved",
        hidden: status !== "approved",
        onSelect: guarded(
          run("Purchase return processed", () =>
            updatePurchaseReturn(pr.id, { status: "processed" }),
          ),
        ),
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
        id: "cancel",
        label: "Cancel",
        icon: XCircle,
        destructive: true,
        hidden: !isPending,
        onSelect: guarded(
          run("Purchase return cancelled", () =>
            updatePurchaseReturn(pr.id, { status: "cancelled" }),
          ),
        ),
      },
      {
        id: "delete",
        label: "Delete",
        icon: Trash2,
        destructive: true,
        hidden: !["pending", "cancelled"].includes(status),
        onSelect: () => {
          if (!window.confirm(`Delete purchase return ${pr.return_number}?`)) return;
          void (async () => {
            try {
              await deletePurchaseReturn(pr.id);
              toast({ title: "Purchase return deleted" });
              onDeleted?.();
            } catch (error: unknown) {
              toast({
                title: "Error deleting return",
                description: normalizeError(error).message,
                variant: "destructive",
              });
            }
          })();
        },
      },
    ];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pr, printing, isReadOnly, navigate, print, send]);

  return { actions, dialogs: <>{emailDialog}</> };
}
