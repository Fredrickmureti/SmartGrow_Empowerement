/**
 * useRecordPrint — shared print action for Purchases object pages.
 *
 * Mirrors the canonical list-page pipeline (build snapshot → ensure
 * document record → submit routing intent) so record pages print through
 * the exact same path the list row menus use instead of shipping a
 * disabled button. See src/features/sales/record/useRecordPrint.ts for the
 * sales-side twin.
 */
import { useCallback, useState } from "react";

import { useToast } from "@/hooks/use-toast";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "@/hooks/useOrganization";
import { useBusinesses } from "@/hooks/useBusinesses";
import { useBranches } from "@/hooks/useBranches";
import { ensureDocumentRecord } from "@/services/documents/ensureDocumentRecord";
import { acknowledgeRecordPrint } from "@/services/printing/acknowledge";
import { fetchAndBuildPurchasesBillSnapshot } from "@/services/documents/snapshots/purchasesBill";
import { fetchAndBuildPurchasesPoSnapshot } from "@/services/documents/snapshots/purchasesPo";
import { fetchAndBuildPurchasesReturnSnapshot } from "@/services/documents/snapshots/purchasesReturn";

export type RecordPrintKind = "bill" | "purchase_order" | "purchase_return";

const KIND_CONFIG: Record<
  RecordPrintKind,
  {
    kindCode: string;
    sourceDocType: string;
    build: (client: typeof supabase, id: string) => Promise<any>;
  }
> = {
  bill: {
    kindCode: "purchases.bill",
    sourceDocType: "bill",
    build: fetchAndBuildPurchasesBillSnapshot,
  },
  purchase_order: {
    kindCode: "purchases.po",
    sourceDocType: "purchase_order",
    build: fetchAndBuildPurchasesPoSnapshot,
  },
  purchase_return: {
    kindCode: "purchases.return",
    sourceDocType: "purchase_return",
    build: fetchAndBuildPurchasesReturnSnapshot,
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
        toast({ title: "No company selected", description: "Pick a company before printing.", variant: "destructive" });
        return;
      }
      if (!currentOrg?.id) {
        toast({ title: "No organization", description: "Sign in to an organization before printing.", variant: "destructive" });
        return;
      }

      const config = KIND_CONFIG[kind];
      setPrinting(true);
      try {
        const built = await config.build(supabase, docId);
        const documentRecordId = await ensureDocumentRecord({
          kindCode: config.kindCode,
          organizationId: currentOrg.id,
          sourceModule: "purchases",
          sourceDocType: config.sourceDocType,
          sourceDocId: docId,
          businessId: built.businessId ?? currentBusiness.id,
          branchId: built.branchId ?? currentBranch?.id ?? null,
          partyKind: "supplier",
          partyId: built.vendorId,
          currency: built.currency,
          documentNumber: built.documentNumber,
          documentDate: built.documentDate,
          snapshot: built.snapshot,
        });
        await acknowledgeRecordPrint(
          { documentRecordId, triggeredSource: "manual" },
          toast,
          { label },
        );
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
