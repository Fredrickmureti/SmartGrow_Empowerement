/**
 * Supplier Master hooks — P1-UI (Supplier 360 workbench).
 *
 * Reads the canonical `suppliers` table (backfilled from vendor-typed
 * contacts by P1 migration). Never queries `contacts` directly — the
 * supplier row is the source of truth. Contact identity is embedded
 * via FK.
 */
import { useCallback, useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "@/hooks/useOrganization";
import { useBusinesses } from "@/contexts/BusinessContext";

export type SupplierLifecycleState =
  | "draft"
  | "qualifying"
  | "approved"
  | "suspended"
  | "blocked"
  | "archived";

export interface SupplierRow {
  id: string;
  organization_id: string;
  business_id: string;
  contact_id: string;
  category_id: string | null;
  supplier_code: string | null;
  lifecycle_state: SupplierLifecycleState;
  preferred_rank: number | null;
  is_preferred: boolean;
  default_currency: string | null;
  default_incoterms: string | null;
  default_payment_term_id: string | null;
  default_lead_time_days: number | null;
  minimum_order_value: number | null;
  hold_reason: string | null;
  qualification_score: number | null;
  last_qualified_at: string | null;
  qualification_expires_at: string | null;
  created_at: string;
  updated_at: string;
  contact?: {
    id: string;
    name: string;
    email: string | null;
    phone: string | null;
    /** Tax identity is owned by the party (ADR-0079) — column is `tax_id`. */
    tax_id: string | null;
  } | null;
  category?: { id: string; code: string; name: string } | null;
}

export function useSuppliers() {
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const [rows, setRows] = useState<SupplierRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchRows = useCallback(async () => {
    if (!currentOrg || !currentBusiness) {
      setRows([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    const { data, error: err } = await (supabase as any)
      .from("suppliers")
      .select(
        "*, contact:contacts(id, name, email, phone, tax_id), category:supplier_categories(id, code, name)",
      )
      .eq("organization_id", currentOrg.id)
      .eq("business_id", currentBusiness.id)
      .order("updated_at", { ascending: false });
    if (err) setError(err.message);
    else setRows((data ?? []) as SupplierRow[]);
    setLoading(false);
  }, [currentOrg?.id, currentBusiness?.id]);

  useEffect(() => {
    fetchRows();
  }, [fetchRows]);

  return { rows, loading, error, refresh: fetchRows };
}

export function useSupplierCategories() {
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const [rows, setRows] = useState<
    { id: string; code: string; name: string; is_active: boolean }[]
  >([]);
  useEffect(() => {
    if (!currentOrg || !currentBusiness) return;
    (async () => {
      const { data } = await (supabase as any)
        .from("supplier_categories")
        .select("id, code, name, is_active")
        .eq("organization_id", currentOrg.id)
        .eq("business_id", currentBusiness.id)
        .eq("is_active", true)
        .order("name");
      setRows((data ?? []) as any);
    })();
  }, [currentOrg?.id, currentBusiness?.id]);
  return rows;
}
