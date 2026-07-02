import { useState, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import { toast } from "sonner";

export interface CountryScope {
  id: string;
  admin_id: string;
  country_code: string;
  assigned_by: string | null;
  assigned_at: string;
}

export function useCountryScopes() {
  const { user } = useAuth();
  const [scopes, setScopes] = useState<CountryScope[]>([]);
  const [isLoading, setIsLoading] = useState(false);

  const fetchScopes = useCallback(async (adminId?: string) => {
    setIsLoading(true);
    try {
      let query = supabase.from("platform_admin_country_scopes").select("*");
      if (adminId) query = query.eq("admin_id", adminId);
      const { data, error } = await query.order("country_code");
      if (error) throw error;
      setScopes((data || []) as CountryScope[]);
    } catch (err) {
      console.error("Error fetching country scopes:", err);
    } finally {
      setIsLoading(false);
    }
  }, []);

  const updateScopes = useCallback(async (adminId: string, countryCodes: string[]) => {
    if (!user) return;
    try {
      // Remove all current scopes
      await supabase
        .from("platform_admin_country_scopes")
        .delete()
        .eq("admin_id", adminId);

      // Add new scopes
      if (countryCodes.length > 0) {
        const rows = countryCodes.map(code => ({
          admin_id: adminId,
          country_code: code,
          assigned_by: user.id,
        }));
        const { error } = await supabase
          .from("platform_admin_country_scopes")
          .insert(rows);
        if (error) throw error;
      }

      // Audit log
      await supabase.from("admin_audit_log").insert({
        admin_user_id: user.id,
        action_type: "country_scopes_updated",
        details: { admin_id: adminId, country_codes: countryCodes },
      });

      toast.success("Country scopes updated");
    } catch (err: any) {
      toast.error("Failed to update country scopes");
    }
  }, [user]);

  return { scopes, isLoading, fetchScopes, updateScopes };
}
