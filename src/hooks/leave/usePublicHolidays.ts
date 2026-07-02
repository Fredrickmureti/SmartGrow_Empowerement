import { useState, useEffect, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "../useOrganization";
import { useBusinesses } from "@/hooks/useBusinesses";
import { usePermissions } from "../usePermissions";
import { toast } from "sonner";

export interface PublicHoliday {
  id: string;
  organization_id: string;
  name: string;
  date: string;
  year: number;
  is_recurring: boolean;
  applies_to_all: boolean;
  branch_ids: string[] | null;
  description: string | null;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

// SCOPE-EXEMPT: public_holidays is intentionally workspace-scoped (no business_id
// column). Public holidays are jurisdiction-level facts (e.g. Kenya New Year)
// that apply to every company in a workspace within the same country.
export function usePublicHolidays() {
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const { can } = usePermissions();
  const [holidays, setHolidays] = useState<PublicHoliday[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  const fetchHolidays = useCallback(async () => {
    if (!currentOrg) return;
    setIsLoading(true);

    try {
      const { data, error } = await supabase
        .from("public_holidays")
        .select("*")
        .eq("organization_id", currentOrg.id)
        .eq("business_id", currentBusiness.id)
        .eq("is_active", true)
        .order("date");

      if (error) throw error;
      setHolidays((data || []) as PublicHoliday[]);
    } catch (error) {
      console.error("Error fetching public holidays:", error);
      toast.error("Failed to fetch public holidays");
    } finally {
      setIsLoading(false);
    }
  }, [currentOrg?.id]);

  useEffect(() => {
    fetchHolidays();
  }, [fetchHolidays]);

  const getHolidaysForYear = (year: number) => {
    return holidays.filter((h) => h.year === year);
  };

  const isHoliday = (date: string): boolean => {
    return holidays.some((h) => h.date === date);
  };

  const createHoliday = async (
    holiday: Omit<PublicHoliday, "id" | "organization_id" | "created_at" | "updated_at">
  ) => {
    if (!currentOrg) throw new Error("No organization selected");
    if (!can("manageLeaveTypes")) throw new Error("You don't have permission to manage public holidays");

    const { data, error } = await supabase
      .from("public_holidays")
      .insert({
        ...holiday,
        organization_id: currentOrg.id,
        business_id: currentBusiness.id,
      })
      .select()
      .single();

    if (error) throw error;

    toast.success("Public holiday created successfully");
    await fetchHolidays();
    return data;
  };

  const updateHoliday = async (id: string, updates: Partial<PublicHoliday>) => {
    if (!can("manageLeaveTypes")) throw new Error("You don't have permission to manage public holidays");
    const { error } = await supabase
      .from("public_holidays")
      .update(updates)
      .eq("id", id);

    if (error) throw error;

    toast.success("Public holiday updated successfully");
    await fetchHolidays();
  };

  const deleteHoliday = async (id: string) => {
    if (!can("manageLeaveTypes")) throw new Error("You don't have permission to manage public holidays");
    const { error } = await supabase
      .from("public_holidays")
      .update({ is_active: false })
      .eq("id", id);

    if (error) throw error;

    toast.success("Public holiday deleted successfully");
    await fetchHolidays();
  };

  return {
    holidays,
    isLoading,
    getHolidaysForYear,
    isHoliday,
    createHoliday,
    updateHoliday,
    deleteHoliday,
    refreshHolidays: fetchHolidays,
  };
}
