import { useState, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "@/hooks/useOrganization";
import { useToast } from "@/hooks/use-toast";
import { normalizeError } from "@/services/resilience";

export interface PaymentRequest {
  id: string;
  organization_id: string;
  pos_transaction_id: string | null;
  provider: string;
  provider_reference: string | null;
  merchant_request_id: string | null;
  amount: number;
  currency: string;
  phone_number: string | null;
  status: "pending" | "processing" | "completed" | "failed" | "cancelled" | "expired";
  result_code: string | null;
  result_description: string | null;
  receipt_number: string | null;
  initiated_at: string;
  completed_at: string | null;
  expires_at: string | null;
  metadata: Record<string, any>;
  callback_payload: Record<string, any> | null;
  created_at: string;
  updated_at: string;
}

export function usePaymentRequests() {
  const { currentOrg } = useOrganization();
  const { toast } = useToast();
  const [isProcessing, setIsProcessing] = useState(false);

  const initiateMpesaPayment = useCallback(
    async (
      phoneNumber: string,
      amount: number,
      posTransactionId?: string
    ): Promise<PaymentRequest | null> => {
      if (!currentOrg) return null;

      setIsProcessing(true);
      try {
        // Call the edge function to initiate STK push
        const response = await supabase.functions.invoke("mpesa-outbound", {
          body: {
            action: "stk_push",
            organizationId: currentOrg.id,
            phoneNumber,
            amount,
            posTransactionId,
          },
        });

        if (response.error) {
          throw new Error(response.error.message || "Failed to initiate M-Pesa payment");
        }

        if (!response.data?.success) {
          throw new Error(response.data?.error || "STK push failed");
        }

        toast({
          title: "STK Push Sent",
          description: "Check the phone for M-Pesa prompt",
        });

        return response.data.paymentRequest as PaymentRequest;
      } catch (error: any) {
        toast({
          title: "M-Pesa Error",
          description: normalizeError(error).message || "Failed to send STK push",
          variant: "destructive",
        });
        return null;
      } finally {
        setIsProcessing(false);
      }
    },
    [currentOrg, toast]
  );

  const checkPaymentStatus = useCallback(
    async (paymentRequestId: string): Promise<PaymentRequest | null> => {
      try {
        const { data, error } = await supabase
          .from("payment_requests")
          .select("*")
          .eq("id", paymentRequestId)
          .single();

        if (error) throw error;
        return data as PaymentRequest;
      } catch (error) {
        console.error("Error checking payment status:", error);
        return null;
      }
    },
    []
  );

  const queryMpesaStatus = useCallback(
    async (paymentRequestId: string): Promise<PaymentRequest | null> => {
      if (!currentOrg) return null;

      try {
        const response = await supabase.functions.invoke("mpesa-outbound", {
          body: {
            action: "query",
            organizationId: currentOrg.id,
            paymentRequestId,
          },
        });

        if (response.error) throw response.error;
        return response.data?.paymentRequest as PaymentRequest;
      } catch (error) {
        console.error("Error querying M-Pesa status:", error);
        return null;
      }
    },
    [currentOrg]
  );

  const cancelPaymentRequest = useCallback(
    async (paymentRequestId: string): Promise<boolean> => {
      try {
        const { error } = await supabase
          .from("payment_requests")
          .update({
            status: "cancelled",
            updated_at: new Date().toISOString(),
          })
          .eq("id", paymentRequestId);

        if (error) throw error;
        return true;
      } catch (error) {
        console.error("Error cancelling payment request:", error);
        return false;
      }
    },
    []
  );

  return {
    isProcessing,
    initiateMpesaPayment,
    checkPaymentStatus,
    queryMpesaStatus,
    cancelPaymentRequest,
  };
}
