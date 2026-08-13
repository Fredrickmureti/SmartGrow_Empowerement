import { useState, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { useOrganization } from "@/hooks/useOrganization";
import { useBranch } from "@/contexts/BranchContext";
import { useSession } from "@/contexts/SessionContext";
import { useBusinesses } from "@/hooks/useBusinesses";
import { parseAssistantContent, type ActionBlock } from "@/lib/ai/actionBlocks";

type AIRequestType = "categorize_expense" | "analyze_invoice" | "financial_insights" | "chat" | "suggest_actions";

export interface Message {
  role: "user" | "assistant";
  content: string;
  /** Validated action blocks parsed from the assistant content (assistant only). */
  actions?: ActionBlock[];
}

interface AIResponse<T = any> {
  success?: boolean;
  data?: T;
  error?: string;
}

export function useAIAssistant() {
  const [isLoading, setIsLoading] = useState(false);
  const [messages, setMessages] = useState<Message[]>([]);
  const { currentOrg } = useOrganization();
  const { currentBranch, branches } = useBranch();
  const { userRole } = useSession();
  const { currentBusiness } = useBusinesses();

  const organizationId = currentOrg?.id;
  const businessId = currentBusiness?.id || null;
  const branchId = currentBranch?.id;
  const accessibleBranchIds = branches.map(b => b.id);

  const categorizeExpense = useCallback(async (description: string, amount: number) => {
    setIsLoading(true);
    try {
      const { data, error } = await supabase.functions.invoke<AIResponse>("ai-assistant", {
        body: { 
          type: "categorize_expense", 
          data: { description, amount },
          organizationId,
          businessId
        }
      });

      if (error) throw error;
      if (data?.error) {
        toast.error(data.error);
        return null;
      }

      return data?.data as { category: string; confidence: number; reasoning: string };
    } catch (error: any) {
      console.error("Error categorizing expense:", error);
      toast.error("Failed to categorize expense");
      return null;
    } finally {
      setIsLoading(false);
    }
  }, [organizationId, businessId]);

  const analyzeInvoice = useCallback(async (invoiceData: {
    invoice_number: string;
    contact_name: string;
    amount: number;
    due_date: string;
    status: string;
    items?: any[];
  }) => {
    setIsLoading(true);
    try {
      const { data, error } = await supabase.functions.invoke<AIResponse>("ai-assistant", {
        body: { 
          type: "analyze_invoice", 
          data: invoiceData,
          organizationId,
          businessId
        }
      });

      if (error) throw error;
      if (data?.error) {
        toast.error(data.error);
        return null;
      }

      return data?.data;
    } catch (error: any) {
      console.error("Error analyzing invoice:", error);
      toast.error("Failed to analyze invoice");
      return null;
    } finally {
      setIsLoading(false);
    }
  }, [organizationId, businessId]);

  const getFinancialInsights = useCallback(async (financialData: {
    revenue: number;
    expenses: number;
    cashFlow: number;
    receivables: number;
    payables: number;
    period: string;
    trends?: any;
  }) => {
    setIsLoading(true);
    try {
      const { data, error } = await supabase.functions.invoke<AIResponse>("ai-assistant", {
        body: { 
          type: "financial_insights", 
          data: financialData,
          organizationId,
          businessId
        }
      });

      if (error) throw error;
      if (data?.error) {
        toast.error(data.error);
        return null;
      }

      return data?.data?.content || data?.data?.raw;
    } catch (error: any) {
      console.error("Error getting insights:", error);
      toast.error("Failed to generate insights");
      return null;
    } finally {
      setIsLoading(false);
    }
  }, [organizationId, businessId]);

  const suggestActions = useCallback(async (contextData: {
    pendingInvoices: number;
    overdueAmount: number;
    recentTransactions?: any[];
    upcomingBills?: any[];
  }) => {
    setIsLoading(true);
    try {
      const { data, error } = await supabase.functions.invoke<AIResponse>("ai-assistant", {
        body: { 
          type: "suggest_actions", 
          data: contextData,
          organizationId,
          businessId
        }
      });

      if (error) throw error;
      if (data?.error) {
        toast.error(data.error);
        return null;
      }

      return data?.data?.suggestions || [];
    } catch (error: any) {
      console.error("Error getting suggestions:", error);
      return [];
    } finally {
      setIsLoading(false);
    }
  }, [organizationId, businessId]);

  const sendChatMessage = useCallback(async (userMessage: string, currentPage?: string) => {
    const newMessages: Message[] = [...messages, { role: "user", content: userMessage }];
    setMessages(newMessages);
    setIsLoading(true);

    try {
      const supabaseUrl = (import.meta.env.VITE_SUPABASE_URL as string) ||
        "https://jkszmrroyjfdwokbkzis.supabase.co";
      const supabaseKey = (import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY as string) || "";

      // Forward the user's session bearer token when present so the edge
      // function can attribute the request to the caller (RLS-safe diagnostics).
      const { data: { session } } = await supabase.auth.getSession();
      const authToken = session?.access_token || supabaseKey;

      const response = await fetch(
        `${supabaseUrl}/functions/v1/ai-assistant`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${authToken}`,
            apikey: supabaseKey,
          },
          body: JSON.stringify({
            type: "chat",
            messages: newMessages,
            organizationId,
            businessId,
            branchId,
            userRole,
            accessibleBranchIds,
            currentPage,
          }),
        }
      );

      if (!response.ok) {
        const errorData = await response
          .json()
          .catch(() => null as { error?: string; reason?: string } | null);
        const mapped = mapAssistantResponseError(response.status, errorData);
        console.error("[ai-assistant] request failed", mapped);
        toast.error(mapped.message);
        setMessages(newMessages);
        return;
      }


      if (!response.body) throw new Error("No response body");

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let assistantContent = "";
      let textBuffer = "";

      // Add empty assistant message that we'll update
      setMessages((prev) => [...prev, { role: "assistant", content: "", actions: [] }]);

      const flush = () => {
        const parsed = parseAssistantContent(assistantContent);
        setMessages((prev) => {
          const updated = [...prev];
          updated[updated.length - 1] = {
            role: "assistant",
            content: parsed.text,
            actions: parsed.actions,
          };
          return updated;
        });
      };

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        textBuffer += decoder.decode(value, { stream: true });

        let newlineIndex: number;
        while ((newlineIndex = textBuffer.indexOf("\n")) !== -1) {
          let line = textBuffer.slice(0, newlineIndex);
          textBuffer = textBuffer.slice(newlineIndex + 1);

          if (line.endsWith("\r")) line = line.slice(0, -1);
          if (line.startsWith(":") || line.trim() === "") continue;
          if (!line.startsWith("data: ")) continue;

          const jsonStr = line.slice(6).trim();
          if (jsonStr === "[DONE]") break;

          try {
            const parsed = JSON.parse(jsonStr);
            const content = parsed.choices?.[0]?.delta?.content;
            if (content) {
              assistantContent += content;
              flush();
            }
          } catch {
            textBuffer = line + "\n" + textBuffer;
            break;
          }
        }
      }

      // Final parse to make sure trailing action lines are picked up.
      flush();
    } catch (error: unknown) {
      const mapped = mapAssistantThrownError(error);
      console.error("[ai-assistant] chat failed", mapped, error);
      toast.error(mapped.message);
      // Remove the user message on error
      setMessages(messages);
    } finally {
      setIsLoading(false);
    }
  }, [messages, organizationId, businessId, branchId, userRole, accessibleBranchIds]);

  const clearChat = useCallback(() => {
    setMessages([]);
  }, []);

  return {
    isLoading,
    messages,
    categorizeExpense,
    analyzeInvoice,
    getFinancialInsights,
    suggestActions,
    sendChatMessage,
    clearChat,
  };
}
