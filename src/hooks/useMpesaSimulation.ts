import { useState, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useToast } from "@/hooks/use-toast";
import { normalizeError } from "@/services/resilience";

export type SimulationScenario = "success" | "cancelled" | "failed" | "timeout";

interface SimulationResult {
  success: boolean;
  status?: string;
  receiptNumber?: string;
  simulatedPayload?: any;
  error?: string;
}

export function useMpesaSimulation() {
  const { toast } = useToast();
  const [isSimulating, setIsSimulating] = useState(false);

  const simulateCallback = useCallback(
    async (
      paymentRequestId: string,
      scenario: SimulationScenario = "success"
    ): Promise<SimulationResult | null> => {
      setIsSimulating(true);
      try {
        const response = await supabase.functions.invoke("mpesa-outbound", {
          body: {
            action: "simulate_callback",
            paymentRequestId,
            scenario,
          },
        });

        if (response.error) {
          throw new Error(response.error.message || "Failed to simulate callback");
        }

        if (!response.data?.success) {
          throw new Error(response.data?.error || "Simulation failed");
        }

        toast({
          title: "Simulation Complete",
          description: `Simulated ${scenario} callback for payment`,
        });

        return response.data as SimulationResult;
      } catch (error: any) {
        toast({
          title: "Simulation Failed",
          description: normalizeError(error).message || "Failed to simulate callback",
          variant: "destructive",
        });
        return null;
      } finally {
        setIsSimulating(false);
      }
    },
    [toast]
  );

  return {
    isSimulating,
    simulateCallback,
  };
}
