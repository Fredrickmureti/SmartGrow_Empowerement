/**
 * useRecordPrint — shared print action for Sales object pages.
 *
 * Mirrors the canonical list-page pipeline (build snapshot → ensure
 * document record → submit routing intent) so record pages print
 * through the exact same path instead of shipping a disabled button.
 */

import { useCallback, useState } from "react";

import { useToast } from "@/hooks/use-toast";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "@/hooks/useOrganization";
import { useBusinesses } from "@/hooks/useBusinesses";
import { useBranches } from "@/hooks/useBranches";
import { ensureDocumentRecord } from "@/services/documents/ensureDocumentRecord";
import { acknowledgeRecordPrint } from "@/services/printing/acknowledge";
import { fetchAndBuildSalesInvoiceSnapshot } from "@/services/documents/snapshots/salesInvoice";
import { fetchAndBuildSalesEstimateSnapshot } from "@/services/documents/snapshots/salesEstimate";
import { fetchAndBuildSalesOrderSnapshot } from "@/services/documents/snapshots/salesOrder";

export type RecordPrintKind = "invoice" | "estimate" | "sales_order";

const KIND_CONFIG: Record<
  RecordPrintKind,
  {
    kindCode: string;
    sourceDocType: string;
    build: (client: typeof supabase, id: string) => Promise<any>;
  }
> = {
  invoice: {
    kindCode: "sales.invoice",
    sourceDocType: "invoice",
    build: fetchAndBuildSalesInvoiceSnapshot,
  },
  estimate: {
    kindCode: "sales.estimate",
    sourceDocType: "estimate",
    build: fetchAndBuildSalesEstimateSnapshot,
  },
  sales_order: {
    kindCode: "sales.order_ack",
    sourceDocType: "sales_order",
    build: fetchAndBuildSalesOrderSnapshot,
  },
};

export function useRecordPrint(kind: RecordPrintKind) {
  const { toast } = useToast();
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const { currentBranch } = useBranches();
  const [printing, setPrinting] = useState(false);

  const print = useCallback(
    async (docId: string, label: string) => {
      if (!docId) return;
      if (!currentBusiness?.id) {
        toast({
          title: "No company selected",
          description: "Pick a company before printing.",
          variant: "destructive",
        });
        return;
      }
      if (!currentOrg?.id) {
        toast({
          title: "No organization",
          description: "Sign in to an organization before printing.",
          variant: "destructive",
        });
        return;
      }

      const config = KIND_CONFIG[kind];
      setPrinting(true);
      try {
        const built = await config.build(supabase, docId);
        const documentRecordId = await ensureDocumentRecord({
          kindCode: config.kindCode,
          organizationId: currentOrg.id,
          sourceModule: "sales",
          sourceDocType: config.sourceDocType,
          sourceDocId: docId,
          businessId: built.businessId ?? currentBusiness.id,
          branchId: built.branchId ?? currentBranch?.id ?? null,
          partyKind: "customer",
          currency: built.currency,
          documentNumber: built.documentNumber,
          documentDate: built.documentDate,
          snapshot: built.snapshot,
        });
        const result = await printDocumentIntent({
          documentRecordId,
          triggeredSource: "manual",
        });
        toast(printOutcomeToast(result, label));
      } catch (err) {
        toast({
          title: "Print failed",
          description: err instanceof Error ? err.message : "Unexpected print error.",
          variant: "destructive",
        });
      } finally {
        setPrinting(false);
      }
    },
    [kind, currentOrg?.id, currentBusiness?.id, currentBranch?.id, toast],
  );

  return { print, printing };
}

export default useRecordPrint;