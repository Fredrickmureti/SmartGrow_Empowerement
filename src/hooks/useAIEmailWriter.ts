import { useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useToast } from "@/hooks/use-toast";

export type EmailAIAction = 
  | "professionalize" 
  | "friendly" 
  | "shorten" 
  | "expand" 
  | "translate"
  | "custom";

interface EmailContext {
  documentType: string;
  documentNumber: string;
  recipientName?: string;
  total?: number;
  currency?: string;
  dueDate?: string;
  organizationName?: string;
}

interface UseAIEmailWriterReturn {
  improveEmail: (
    currentMessage: string,
    action: EmailAIAction,
    context: EmailContext,
    customInstruction?: string,
    targetLanguage?: string
  ) => Promise<string | null>;
  isLoading: boolean;
}

export function useAIEmailWriter(): UseAIEmailWriterReturn {
  const [isLoading, setIsLoading] = useState(false);
  const { toast } = useToast();

  const getActionPrompt = (
    action: EmailAIAction,
    currentMessage: string,
    context: EmailContext,
    customInstruction?: string,
    targetLanguage?: string
  ): string => {
    const contextInfo = `
Document: ${context.documentType} #${context.documentNumber}
Recipient: ${context.recipientName || "Customer"}
${context.total && context.currency ? `Amount: ${context.currency} ${context.total}` : ""}
${context.dueDate ? `Due Date: ${context.dueDate}` : ""}
Organization: ${context.organizationName || "Our Company"}
`;

    const basePrompt = `You are an expert business email writer. Here is the context:
${contextInfo}

Current email message:
"""
${currentMessage}
"""

`;

    switch (action) {
      case "professionalize":
        return basePrompt + `Rewrite this email to be more professional and formal while maintaining the same information. Use business-appropriate language, proper greetings, and a polished tone. Keep it concise but thorough.`;
      
      case "friendly":
        return basePrompt + `Rewrite this email to be warmer and more friendly while still being professional. Add a personal touch, use approachable language, but maintain business appropriateness.`;
      
      case "shorten":
        return basePrompt + `Condense this email to its essential points. Remove unnecessary words and phrases while keeping all critical information. Aim for clarity and brevity.`;
      
      case "expand":
        return basePrompt + `Expand this email with more detail and context. Add helpful information, provide clearer explanations, and ensure the recipient has all the information they need. Maintain a professional tone.`;
      
      case "translate":
        return basePrompt + `Translate this email to ${targetLanguage || "Spanish"}. Maintain the same tone, formality level, and all the information from the original message. Adapt cultural nuances appropriately.`;
      
      case "custom":
        return basePrompt + `Apply the following instruction to improve this email:\n${customInstruction || "Make it better"}`;
      
      default:
        return basePrompt + `Improve this email while maintaining its core message.`;
    }
  };

  const improveEmail = async (
    currentMessage: string,
    action: EmailAIAction,
    context: EmailContext,
    customInstruction?: string,
    targetLanguage?: string
  ): Promise<string | null> => {
    if (!currentMessage.trim()) {
      toast({
        title: "No content",
        description: "Please write some content before using AI assistance.",
        variant: "destructive",
      });
      return null;
    }

    setIsLoading(true);

    try {
      const prompt = getActionPrompt(action, currentMessage, context, customInstruction, targetLanguage);

      const { data, error } = await supabase.functions.invoke("ai-assistant", {
        body: {
          type: "email_assist",
          data: {
            prompt,
            currentMessage,
            action,
            context,
          },
        },
      });

      if (error) {
        throw error;
      }

      if (data?.error) {
        throw new Error(data.error);
      }

      const improvedMessage = data?.data?.content || data?.data?.improvedMessage;
      
      if (!improvedMessage) {
        throw new Error("No improved message returned from AI");
      }

      toast({
        title: "Email improved",
        description: "AI has enhanced your email message.",
      });

      return improvedMessage;
    } catch (error: any) {
      console.error("AI email writer error:", error);
      
      let errorMessage = "Failed to improve email. Please try again.";
      if (error.message?.includes("Rate limit")) {
        errorMessage = "AI rate limit reached. Please try again in a moment.";
      } else if (error.message?.includes("disabled")) {
        errorMessage = "AI features are currently disabled.";
      }

      toast({
        title: "AI Error",
        description: errorMessage,
        variant: "destructive",
      });
      
      return null;
    } finally {
      setIsLoading(false);
    }
  };

  return { improveEmail, isLoading };
}
