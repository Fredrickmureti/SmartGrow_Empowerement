import { useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useToast } from "@/hooks/use-toast";

export type EmailAction = "generate" | "improve" | "translate" | "html_beautify" | "subject_suggestions";
export type EmailType = "welcome" | "reengagement" | "announcement" | "maintenance" | "custom";
export type EmailTone = "professional" | "friendly" | "marketing" | "urgent";

interface GenerateEmailParams {
  action: EmailAction;
  emailType?: EmailType;
  currentContent?: string;
  prompt?: string;
  targetLanguage?: string;
  variables?: Record<string, string>;
  tone?: EmailTone;
}

interface UseAdminAIEmailReturn {
  generateEmail: (params: GenerateEmailParams) => Promise<{ content?: string; subjects?: string[] } | null>;
  isLoading: boolean;
}

export function useAdminAIEmail(): UseAdminAIEmailReturn {
  const [isLoading, setIsLoading] = useState(false);
  const { toast } = useToast();

  const generateEmail = async (params: GenerateEmailParams): Promise<{ content?: string; subjects?: string[] } | null> => {
    setIsLoading(true);

    try {
      const { data, error } = await supabase.functions.invoke("ai-generate-email", {
        body: params,
      });

      if (error) {
        throw error;
      }

      if (data?.error) {
        throw new Error(data.error);
      }

      const actionLabels: Record<EmailAction, string> = {
        generate: "Email generated",
        improve: "Email improved",
        translate: "Email translated",
        html_beautify: "HTML created",
        subject_suggestions: "Subjects generated",
      };

      toast({
        title: actionLabels[params.action],
        description: "AI has processed your request.",
      });

      return data?.data || null;
    } catch (error: any) {
      console.error("AI email error:", error);
      
      let errorMessage = "Failed to process request. Please try again.";
      if (error.message?.includes("Rate limit")) {
        errorMessage = "AI rate limit reached. Please try again in a moment.";
      } else if (error.message?.includes("No AI providers")) {
        errorMessage = "AI providers not configured. Contact administrator.";
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

  return { generateEmail, isLoading };
}
