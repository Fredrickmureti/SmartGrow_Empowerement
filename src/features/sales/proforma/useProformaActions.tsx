/**
 * useProformaActions — the single declaration of what you can do to a
 * Proforma Invoice, rendered identically by the list row menu and the
 * record page.
 */
import { useMemo } from "react";
import { useNavigate } from "react-router-dom";
import {
  Ban,
  FileSearch,
  FileText,
  Mail,
  Printer,
  Send,
  Trash2,
} from "lucide-react";

import type { DocumentAction } from "@/design-system/records";
import { useDocumentPreview } from "@/components/documents/DocumentPreviewProvider";
import { useDocumentEmail } from "@/features/sales/record/useDocumentEmail";
import { useOrganization } from "@/hooks/useOrganization";
import { useBusinesses } from "@/hooks/useBusinesses";
import { useToast } from "@/hooks/use-toast";
import { useProformaInvoices, type ProformaInvoice } from "@/hooks/useProformaInvoices";
import { supabase } from "@/integrations/supabase/client";
import { fetchAndBuildSalesProformaSnapshot } from "@/services/documents/snapshots/salesProforma";
import { ensureDocumentRecord } from "@/services/documents/ensureDocumentRecord";
import { acknowledgeRecordPrint } from "@/services/printing/acknowledge";
import { normalizeError } from "@/services/resilience";

interface Options {
  onChanged?: () => void;
  onDeleted?: () => void;
}

type Proforma = ProformaInvoice & {
  contact?: { name?: string | null; email?: string | null } | null;
};

export function useProformaActions(
  proforma: Proforma | null | undefined,
  { onChanged, onDeleted }: Options = {},
) {
  const navigate = useNavigate();
  const { toast } = useToast();
  const { preview } = useDocumentPreview();
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const { setProformaStatus, convertToInvoice, deleteProformaInvoice } = useProformaInvoices();
  const { send, dialog } = useDocumentEmail(onChanged);

  const print = async (inv: Proforma) => {
    if (!currentBusiness?.id || !currentOrg?.id) {
      toast({
        title: "Cannot print",
        description: "Pick an organization and company before printing.",
        variant: "destructive",
      });
      return;
    }
    try {
      const built = await fetchAndBuildSalesProformaSnapshot(supabase, inv.id);
      const documentRecordId = await ensureDocumentRecord({
        kindCode: "sales.proforma",
        organizationId: currentOrg.id,
        sourceModule: "sales",
        sourceDocType: "proforma",
        sourceDocId: inv.id,
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
        { label: `Proforma ${inv.proforma_number}` },
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
    const inv = proforma;
    if (!inv) return [];
    const status = inv.status as string;
    const isDraft = status === "draft";
    const isConvertible = status === "sent" || status === "accepted";
    const isCancellable = !["converted", "cancelled"].includes(status);
    const isDeletable = status !== "converted";

    const run = (label: string, fn: () => Promise<unknown>) => () => {
      void (async () => {
        try {
          await fn();
          onChanged?.();
        } catch (error: unknown) {
          toast({
            title: label,
            description: normalizeError(error).message,
            variant: "destructive",
          });
        }
      })();
    };

    return [
      {
        id: "mark-sent",
        label: "Mark as sent",
        icon: Send,
        group: "core",
        primary: isDraft,
        hidden: !isDraft,
        onSelect: run("Failed to mark as sent", () => setProformaStatus(inv.id, "sent")),
      },
      {
        id: "convert",
        label: "Convert to invoice",
        icon: FileText,
        group: "core",
        primary: isConvertible,
        hidden: !isConvertible,
        onSelect: run("Failed to convert to invoice", () => convertToInvoice(inv.id)),
      },
      {
        id: "preview",
        label: "Preview",
        icon: FileSearch,
        group: "output",
        onSelect: () =>
          preview({
            documentType: "proforma",
            documentId: inv.id,
            title: `Proforma ${inv.proforma_number}`,
            filename: `proforma-${inv.proforma_number}`,
          }),
      },
      {
        id: "print",
        label: "Print proforma",
        icon: Printer,
        group: "output",
        onSelect: () => void print(inv),
      },
      {
        id: "email",
        label: "Send via email",
        icon: Mail,
        group: "output",
        onSelect: () =>
          send({
            documentType: "proforma",
            documentId: inv.id,
            documentNumber: inv.proforma_number,
            recipientEmail: inv.contact?.email || "",
            recipientName: inv.contact?.name || "",
            total: inv.total,
            currency: inv.currency || undefined,
          } as never),
      },
      {
        id: "cancel",
        label: "Cancel proforma",
        icon: Ban,
        destructive: true,
        hidden: !isCancellable,
        onSelect: run("Failed to cancel proforma", () => setProformaStatus(inv.id, "cancelled")),
      },
      {
        id: "delete",
        label: "Delete",
        icon: Trash2,
        destructive: true,
        hidden: !isDeletable,
        onSelect: () =>
          void (async () => {
            try {
              await deleteProformaInvoice(inv.id);
              onDeleted?.();
            } catch (error: unknown) {
              toast({
                title: "Error deleting proforma",
                description: normalizeError(error).message,
                variant: "destructive",
              });
            }
          })(),
      },
    ];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [proforma, navigate, preview, send, currentOrg?.id, currentBusiness?.id]);

  return { actions, dialogs: dialog };
}
