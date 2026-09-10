/**
 * useCounterparties
 *
 * Journal-entry counterparties are microfinance clients. The inherited ERP
 * `contacts` table is retired; `mf_clients` is the single party register for
 * this institution, so any GL line that needs a subledger party points here.
 *
 * Read-only by design — clients are created through the lending onboarding
 * flow, never from the finance screens.
 */
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useBusinesses } from "./useBusinesses";
import { useToast } from "./use-toast";
import { normalizeError } from "@/services/resilience";

export interface Counterparty {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  reference: string | null;
  is_active: boolean;
}

export function useCounterparties() {
  const { currentBusiness } = useBusinesses();
  const { toast } = useToast();
  const [counterparties, setCounterparties] = useState<Counterparty[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      if (!currentBusiness) {
        setCounterparties([]);
        setIsLoading(false);
        return;
      }
      setIsLoading(true);
      try {
        const { data, error } = await supabase
          .from("mf_clients")
          .select("id, full_name, email, phone, client_number, status")
          .eq("business_id", currentBusiness.id)
          .order("full_name");

        if (error) throw error;
        if (cancelled) return;

        setCounterparties(
          (data ?? []).map((row) => ({
            id: row.id,
            name: row.full_name,
            email: row.email,
            phone: row.phone,
            reference: row.client_number,
            is_active: row.status === "active",
          })),
        );
      } catch (error) {
        if (cancelled) return;
        toast({
          title: "Error loading clients",
          description: normalizeError(error).message,
          variant: "destructive",
        });
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    };

    void load();
    return () => {
      cancelled = true;
    };
  }, [currentBusiness?.id]);

  return { counterparties, isLoading };
}
