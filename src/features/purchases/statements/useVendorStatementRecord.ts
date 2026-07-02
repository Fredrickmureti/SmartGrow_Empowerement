/**
 * useVendorStatementRecord — canonical single-record fetch for the
 * Vendor Statement peek + record page. Fetches the saved
 * `vendor_statements` header row and regenerates the fully rendered
 * `VendorStatementData` payload via `useVendorStatements.generateStatementData`
 * so the peek sheet and full record page render the same body that the
 * PDF/email pipeline uses. Mirrors `useBillRecord` shape for other
 * Purchases records.
 */
import { useCallback, useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "@/hooks/useOrganization";
import { useBusinesses } from "@/hooks/useBusinesses";
import {
  useVendorStatements,
  type VendorStatement,
  type VendorStatementData,
} from "@/hooks/useVendorStatements";

export interface VendorStatementRecord {
  header: VendorStatement;
  data: VendorStatementData;
}

export function useVendorStatementRecord(id: string | null | undefined) {
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const { generateStatementData } = useVendorStatements();
  const [record, setRecord] = useState<VendorStatementRecord | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reloadTick, setReloadTick] = useState(0);

  useEffect(() => {
    if (!id || !currentOrg?.id || !currentBusiness?.id) {
      setRecord(null);
      return;
    }
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(null);
      try {
        const { data: header, error: headerErr } = await supabase
          .from("vendor_statements")
          .select("*, contacts(id, name, email, parent:contacts!parent_contact_id(name))")
          .eq("id", id)
          .eq("organization_id", currentOrg.id)
          .eq("business_id", currentBusiness.id)
          .maybeSingle();
        if (headerErr) throw headerErr;
        if (!header) throw new Error("Statement not found.");
        const data = await generateStatementData({
          contact_id: (header as any).contact_id,
          period_start: (header as any).period_start,
          period_end: (header as any).period_end,
        });
        if (cancelled) return;
        setRecord({
          header: {
            ...(header as any),
            contacts: (header as any).contacts
              ? {
                  ...(header as any).contacts,
                  company: (header as any).contacts?.parent?.name ?? null,
                }
              : (header as any).contacts,
          } as VendorStatement,
          data,
        });
      } catch (err: any) {
        if (!cancelled) setError(err?.message ?? String(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // generateStatementData is stable enough for our purposes; excluded to
    // avoid re-runs when the hook re-renders.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, currentOrg?.id, currentBusiness?.id, reloadTick]);

  const reload = useCallback(() => setReloadTick((t) => t + 1), []);

  return { record, loading, error, reload };
}
