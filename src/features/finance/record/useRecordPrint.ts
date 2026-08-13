/**
 * useRecordPrint (finance) — print action for finance record surfaces.
 *
 * Twin of the sales and purchases hooks: build the frozen snapshot, freeze
 * it into a `document_records` row, then submit the routing intent. Finance
 * artefacts are ledger evidence, so there is no counterparty and no email
 * disposition — only view / download / print.
 */
import { useCallback, useState } from "react";

import { useToast } from "@/hooks/use-toast";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "@/hooks/useOrganization";
import { useBusinesses } from "@/hooks/useBusinesses";
import { useBranches } from "@/hooks/useBranches";
import { ensureDocumentRecord } from "@/services/documents/ensureDocumentRecord";
import { acknowledgeRecordPrint } from "@/services/printing/acknowledge";
import { fetchAndBuildFinanceJournalEntrySnapshot } from "@/services/documents/snapshots/financeJournalEntry";

export type FinanceRecordPrintKind = "journal_entry";

const KIND_CONFIG: Record<
  FinanceRecordPrintKind,
  {
    kindCode: string;
    sourceDocType: string;
    build: (client: typeof supabase, id: string) => Promise<{
      snapshot: Record<string, unknown>;
      documentNumber: string;
      documentDate: string;
      organizationId: string;
      businessId: string | null;
      branchId: string | null;
      currency: string;
    }>;
  }
> = {
  journal_entry: {
    kindCode: "finance.journal_entry",
    sourceDocType: "journal_entry",
    build: fetchAndBuildFinanceJournalEntrySnapshot,
  },
};

export function useRecordPrint(kind: FinanceRecordPrintKind) {
  const { toast } = useToast();
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const { currentBranch } = useBranches();
  const [printing, setPrinting] = useState(false);

  const print = useCallback(
    async (docId: string, label: string) => {
      if (!docId || printing) return;
      const config = KIND_CONFIG[kind];
      setPrinting(true);
      try {
        const built = await config.build(supabase, docId);
        const documentRecordId = await ensureDocumentRecord({
          kindCode: config.kindCode,
          organizationId: built.organizationId ?? currentOrg?.id ?? "",
          sourceModule: "finance",
          sourceDocType: config.sourceDocType,
          sourceDocId: docId,
          businessId: built.businessId ?? currentBusiness?.id ?? null,
          branchId: built.branchId ?? currentBranch?.id ?? null,
          // Ledger evidence has no counterparty.
          partyKind: null,
          partyId: null,
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
    [kind, printing, currentOrg?.id, currentBusiness?.id, currentBranch?.id, toast],
  );

  return { print, printing };
}

export default useRecordPrint;
