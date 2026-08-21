import { useState, useCallback, useEffect, useMemo } from "react";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { useOrganization } from "@/hooks/useOrganization";
import { useBranch } from "@/contexts/BranchContext";
import { useSession } from "@/contexts/SessionContext";
import { useBusinesses } from "@/hooks/useBusinesses";
import { parseAssistantContent, type ActionBlock } from "@/lib/ai/actionBlocks";
import {
  mapAssistantResponseError,
  mapAssistantThrownError,
} from "@/lib/ai/assistantErrors";
import { deriveWorkingContext, type ScopeMode } from "@/lib/ai/workingContext";
import { useAIConversation } from "@/hooks/useAIConversation";

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

export interface UseAIAssistantOptions {
  /** Route the assistant is being used from; drives conversation scope. */
  currentPath?: string;
  /** Branch-scoped thread (default) or a company-wide one. */
  scopeMode?: ScopeMode;
}

export function useAIAssistant(options: UseAIAssistantOptions = {}) {
  const { currentPath, scopeMode = "branch" } = options;
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

  const workingContext = useMemo(
    () => deriveWorkingContext(currentPath ?? "/"),
    [currentPath],
  );

  const {
    conversationId,
    history,
    isLoadingHistory,
    ensureConversation,
    archiveConversation,
  } = useAIConversation({
    organizationId,
    businessId,
    branchId,
    appKey: workingContext.appKey,
    moduleKey: workingContext.moduleKey,
    scopeMode,
  });

  // History is the source of truth for the bound thread. Rebinding the scope
  // (org / business / branch / app / scope mode) replaces the visible thread
  // instead of letting the previous scope's messages follow the user.
  useEffect(() => {
    setMessages(
      history.map((m) => ({
        role: m.role,
        content: m.role === "assistant" ? parseAssistantContent(m.content).text : m.content,
        ...(m.role === "assistant"
          ? { actions: parseAssistantContent(m.content).actions }
          : {}),
      })),
    );
  }, [history, conversationId]);


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

      // Bind the turn to a persisted, scope-keyed thread. When it exists the
      // server rebuilds history from the database and only the new turn is
      // trusted from the client.
      const threadId = await ensureConversation(userMessage);

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
            messages: threadId
              ? [{ role: "user", content: userMessage }]
              : newMessages,
            organizationId,
            businessId,
            branchId,
            userRole,
            accessibleBranchIds,
            currentPage: currentPage ?? workingContext.path,
            conversationId: threadId,
            workingContext,
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
      let bubbleAdded = false;
      let streamError: string | null = null;

      const flush = () => {
        const parsed = parseAssistantContent(assistantContent);
        // Only materialise the assistant bubble once there is something to
        // show. Adding it up-front produced the "empty reply" thread: the
        // typing indicator disappeared (last message was no longer the user's)
        // and a blank bubble was left behind whenever the stream carried no
        // content at all.
        if (!bubbleAdded) {
          if (!parsed.text && parsed.actions.length === 0) return;
          bubbleAdded = true;
          setMessages((prev) => [
            ...prev,
            { role: "assistant", content: parsed.text, actions: parsed.actions },
          ]);
          return;
        }
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
            // Providers signal mid-stream failures as a data frame carrying an
            // `error` object. Previously this was silently dropped, so the user
            // got a blank bubble instead of the reason.
            const errObj = parsed?.error;
            if (errObj) {
              streamError =
                (typeof errObj === "string" ? errObj : errObj?.message) ||
                "The AI provider ended the response with an error.";
              continue;
            }
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

      // An empty stream is a failure, not an answer. Surface it instead of
      // leaving a silent, empty reply thread.
      if (!bubbleAdded) {
        const reason =
          streamError ??
          "The assistant returned an empty response. Nothing was saved — please try again.";
        console.error("[ai-assistant] empty stream", { reason });
        toast.error(reason);
        setMessages([
          ...newMessages,
          { role: "assistant", content: `⚠️ ${reason}`, actions: [] },
        ]);
      } else if (streamError) {
        toast.error(streamError);
      }

    } catch (error: unknown) {
      const mapped = mapAssistantThrownError(error);
      console.error("[ai-assistant] chat failed", mapped, error);
      toast.error(mapped.message);
      // Remove the user message on error
      setMessages(messages);
    } finally {
      setIsLoading(false);
    }
  }, [
    messages,
    organizationId,
    businessId,
    branchId,
    userRole,
    accessibleBranchIds,
    ensureConversation,
    workingContext,
  ]);

  /** Archives the bound thread so the next turn starts a fresh one. */
  const clearChat = useCallback(async () => {
    setMessages([]);
    await archiveConversation();
  }, [archiveConversation]);

  return {
    isLoading: isLoading || isLoadingHistory,
    messages,
    conversationId,
    workingContext,
    categorizeExpense,
    analyzeInvoice,
    getFinancialInsights,
    suggestActions,
    sendChatMessage,
    clearChat,

  };
}
