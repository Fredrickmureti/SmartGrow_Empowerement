import { useState, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "./useOrganization";
import { toast } from "sonner";
import { normalizeError } from "@/services/resilience";

export interface BusinessAccessRow {
  id: string;
  user_id: string;
  business_id: string;
  organization_id: string;
  is_primary: boolean;
  can_switch: boolean;
  business_name?: string;
}

export function useBusinessAccess(userId: string | undefined) {
  const { currentOrg } = useOrganization();
  const [accessRows, setAccessRows] = useState<BusinessAccessRow[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isSaving, setIsSaving] = useState(false);

  const fetchAccess = useCallback(async () => {
    if (!userId || !currentOrg) return;
    setIsLoading(true);
    try {
      const { data, error } = await supabase
        // SCOPE-EXEMPT: `user_business_access` is workspace-wide (no business_id column)
        .from("user_business_access")
        .select("*, businesses!user_business_access_business_id_fkey(name)")
        .eq("user_id", userId)
        .eq("organization_id", currentOrg.id);

      if (error) throw error;

      setAccessRows(
        (data || []).map((row: any) => ({
          id: row.id,
          user_id: row.user_id,
          business_id: row.business_id,
          organization_id: row.organization_id,
          is_primary: row.is_primary,
          can_switch: row.can_switch,
          business_name: row.businesses?.name || "Unknown",
        }))
      );
    } catch (err) {
      console.error("Error fetching business access:", err);
    } finally {
      setIsLoading(false);
    }
  }, [userId, currentOrg?.id]);

  const saveAccess = async (
    updates: Array<{
      business_id: string;
      is_primary: boolean;
      can_switch: boolean;
    }>
  ) => {
    if (!userId || !currentOrg) return;
    setIsSaving(true);
    try {
      // Delete all existing access rows for this user in this org
      const { error: delError } = await supabase
        .from("user_business_access")
        .delete()
        .eq("user_id", userId)
        .eq("organization_id", currentOrg.id);

      if (delError) throw delError;

      // Insert new rows
      if (updates.length > 0) {
        const rows = updates.map((u) => ({
          user_id: userId,
          business_id: u.business_id,
          organization_id: currentOrg.id,
          is_primary: u.is_primary,
          can_switch: u.can_switch,
        }));

        const { error: insError } = await supabase
          .from("user_business_access")
          .insert(rows);

        if (insError) throw insError;
      }

      toast.success("Business access updated");
      await fetchAccess();
    } catch (err: any) {
      console.error("Error saving business access:", err);
      toast.error(normalizeError(err).message || "Failed to update business access");
    } finally {
      setIsSaving(false);
    }
  };

  return { accessRows, isLoading, isSaving, fetchAccess, saveAccess };
}
