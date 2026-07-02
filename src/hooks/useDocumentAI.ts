import { useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useToast } from "@/hooks/use-toast";
import { normalizeError } from "@/services/resilience";

export type DocumentType = "estimate" | "invoice" | "proforma" | "sales_order";
export type FieldType = "notes" | "terms";
export type AIAction = "generate" | "improve" | "professional";

interface DocumentContext {
  documentType: DocumentType;
  customerName?: string;
  documentNumber?: string;
  lineItemsSummary?: string;
  totalAmount?: number;
  currency?: string;
}

interface UseDocumentAIReturn {
  generateText: (
    action: AIAction,
    fieldType: FieldType,
    currentText?: string
  ) => Promise<string | null>;
  isLoading: boolean;
}

export function useDocumentAI(context: DocumentContext): UseDocumentAIReturn {
  const [isLoading, setIsLoading] = useState(false);
  const { toast } = useToast();

  const generateText = async (
    action: AIAction,
    fieldType: FieldType,
    currentText?: string
  ): Promise<string | null> => {
    setIsLoading(true);

    try {
      const { data, error } = await supabase.functions.invoke("ai-assistant", {
        body: {
          type: "document_text",
          data: {
            action,
            fieldType,
            documentType: context.documentType,
            customerName: context.customerName,
            documentNumber: context.documentNumber,
            lineItemsSummary: context.lineItemsSummary,
            totalAmount: context.totalAmount,
            currency: context.currency,
            currentText,
          },
        },
      });

      if (error) {
        throw new Error(error.message || "Failed to generate text");
      }

      if (data?.error) {
        throw new Error(data.error);
      }

      const generatedText = data?.data?.content || data?.data?.text;
      if (!generatedText) {
        throw new Error("No text was generated");
      }

      return generatedText;
    } catch (error: any) {
      console.error("Document AI error:", error);
      toast({
        title: "AI Generation Failed",
        description: normalizeError(error).message || "Unable to generate text. Please try again.",
        variant: "destructive",
      });
      return null;
    } finally {
      setIsLoading(false);
    }
  };

  return {
    generateText,
    isLoading,
  };
}
