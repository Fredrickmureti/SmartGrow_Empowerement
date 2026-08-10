/**
 * useSalesReturnActions — the single declaration of what you can do to a
 * Sales Return, rendered identically by the list row menu and the record
 * page.
 */
import { useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { CheckCircle, FileSearch, Mail, Printer, Trash2, XCircle } from "lucide-react";

import type { DocumentAction } from "@/design-system/records";
import { useDocumentPreview } from "@/components/documents/DocumentPreviewProvider";
import { useDocumentEmail } from "@/features/sales/record/useDocumentEmail";
import { useOrganization } from "@/hooks/useOrganization";
import { useBusinesses } from "@/hooks/useBusinesses";
import { useToast } from "@/hooks/use-toast";
import { useSalesReturns, type SalesReturn } from "@/hooks/useSalesReturns";
import { supabase } from "@/integrations/supabase/client";
import { fetchAndBuildSalesReturnSnapshot } from "@/services/documents/snapshots/salesReturn";
import { ensureDocumentRecord } from "@/services/documents/ensureDocumentRecord";
import { acknowledgeRecordPrint } from "@/services/printing/acknowledge";
import { normalizeError } from "@/services/resilience";

interface Options {
  onChanged?: () => void;
  onDeleted?: () => void;
}

type Row = SalesReturn & { contact?: { name?: string | null; email?: string | null } | null };

export function useSalesReturnActions(
  ret: Row | null | undefined,
  { onChanged, onDeleted }: Options = {},
) {
  const navigate = useNavigate();
  const { toast } = useToast();
  const { preview } = useDocumentPreview();
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const { approveReturn, rejectReturn, deleteSalesReturn } = useSalesReturns();
  const { send, dialog } = useDocumentEmail(onChanged);

  const print = async (r: Row) => {
    if (!currentBusiness?.id || !currentOrg?.id) {
      toast({
        title: "Cannot print",
        description: "Pick an organization and company before printing.",
        variant: "destructive",
      });
      return;
    }
    try {
      const built = await fetchAndBuildSalesReturnSnapshot(supabase, r.id);
      const documentRecordId = await ensureDocumentRecord({
        kindCode: "sales.return",
        organizationId: currentOrg.id,
        sourceModule: "sales",
        sourceDocType: "sales_return",
        sourceDocId: r.id,
        businessId: built.businessId ?? currentBusiness.id,
        branchId: built.branchId ?? null,
        partyKind: "customer",
        currency: built.currency,
        documentNumber: built.documentNumber,
        documentDate: built.documentDate,
        snapshot: built.snapshot,
      });
      await acknowledgeRecordPrint(
        { documentRecordId, triggeredSource: "manual" },
        toast,
        { label: `Sales return ${r.return_number}` },
      );
    } catch (err) {
      toast({
        title: "Print failed",
        description: normalizeError(err).message,
        variant: "destructive",
      });
    }
  };

  const actions = useMemo<DocumentAction[]>(() => {
    if (!ret) return [];
    const isPending = ret.status === "pending";

    return [
      {
        id: "approve",
        label: "Approve & create credit note",
        icon: CheckCircle,
        group: "core",
        primary: isPending,
        hidden: !isPending,
        onSelect: () => void approveReturn(ret.id).then(onChanged),
      },
      {
        id: "reject",
        label: "Reject",
        icon: XCircle,
        group: "core",
        hidden: !isPending,
        onSelect: () => void rejectReturn(ret.id).then(onChanged),
      },
      {
        id: "preview",
        label: "Preview",
        icon: FileSearch,
        group: "output",
        onSelect: () =>
          preview({
            documentType: "sales_return",
            documentId: ret.id,
            title: `Return ${ret.return_number}`,
            filename: `sales-return-${ret.return_number}`,
          }),
      },
      {
        id: "print",
        label: "Print A4",
        icon: Printer,
        group: "output",
        onSelect: () => void print(ret),
      },
      {
        id: "email",
        label: "Email return",
        icon: Mail,
        group: "output",
        onSelect: () =>
          send({
            documentType: "sales_return",
            documentId: ret.id,
            documentNumber: ret.return_number,
            recipientEmail: ret.contact?.email || "",
            recipientName: ret.contact?.name || "",
            total: ret.total,
            currency: ret.currency || undefined,
          } as never),
      },
      {
        id: "delete",
        label: "Delete",
        icon: Trash2,
        destructive: true,
        hidden: !isPending,
        onSelect: () =>
          void (async () => {
            try {
              await deleteSalesReturn(ret.id);
              onDeleted?.();
            } catch (error: unknown) {
              toast({
                title: "Error deleting return",
                description: normalizeError(error).message,
                variant: "destructive",
              });
            }
          })(),
      },
    ];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ret, navigate, preview, send, currentOrg?.id, currentBusiness?.id]);

  return { actions, dialogs: dialog };
}
