/**
 * Conversation binding for the AI assistant.
 *
 * A thread belongs to exactly one (organization, business, branch?, app) scope.
 * Switching tenant, business, branch, app, or scope mode rebinds to a
 * different thread — conversations never bleed across scopes, and history is
 * reloaded from the database rather than carried in volatile React state.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import type { ScopeMode } from "@/lib/ai/workingContext";

export interface StoredMessage {
  role: "user" | "assistant";
  content: string;
}

export interface ConversationScope {
  organizationId: string | null | undefined;
  businessId: string | null;
  branchId: string | null | undefined;
  appKey: string;
  moduleKey: string | null;
  scopeMode: ScopeMode;
}

interface UseAIConversationResult {
  conversationId: string | null;
  history: StoredMessage[];
  isLoadingHistory: boolean;
  /** Creates the thread on first send and returns its id. */
  ensureConversation: (firstMessage: string) => Promise<string | null>;
  /** Archives the current thread and starts an empty one in the same scope. */
  archiveConversation: () => Promise<void>;
  reload: () => Promise<void>;
}

function scopeLevel(scope: ConversationScope): "branch" | "business" | "organization" {
  if (scope.scopeMode === "branch" && scope.branchId) return "branch";
  return scope.businessId ? "business" : "organization";
}

export function useAIConversation(scope: ConversationScope): UseAIConversationResult {
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [history, setHistory] = useState<StoredMessage[]>([]);
  const [isLoadingHistory, setIsLoadingHistory] = useState(false);

  const { organizationId, businessId, branchId, appKey, moduleKey, scopeMode } = scope;
  const effectiveBranchId = scopeMode === "branch" ? branchId ?? null : null;
  const scopeKey = [organizationId, businessId, effectiveBranchId, appKey, scopeMode].join("|");
  const scopeKeyRef = useRef(scopeKey);
  scopeKeyRef.current = scopeKey;

  const resolve = useCallback(async () => {
    if (!organizationId) {
      setConversationId(null);
      setHistory([]);
      return;
    }
    const requestedScope = scopeKeyRef.current;
    setIsLoadingHistory(true);
    try {
      let query = supabase
        .from("ai_conversations")
        .select("id")
        .eq("organization_id", organizationId)
        .eq("app_key", appKey)
        .is("archived_at", null)
        .order("last_message_at", { ascending: false })
        .limit(1);

      query = businessId
        ? query.eq("business_id", businessId)
        : query.is("business_id", null);
      query = effectiveBranchId
        ? query.eq("branch_id", effectiveBranchId)
        : query.is("branch_id", null);

      const { data: rows, error } = await query;
      if (error) throw error;
      // A scope switch may have landed while this query was in flight.
      if (requestedScope !== scopeKeyRef.current) return;

      const found = rows?.[0]?.id ?? null;
      setConversationId(found);

      if (!found) {
        setHistory([]);
        return;
      }
      const { data: messageRows, error: messagesError } = await supabase
        .from("ai_conversation_messages")
        .select("role, content")
        .eq("conversation_id", found)
        .order("created_at", { ascending: true })
        .limit(100);
      if (messagesError) throw messagesError;
      if (requestedScope !== scopeKeyRef.current) return;

      setHistory(
        (messageRows ?? [])
          .filter((m) => m.role === "user" || m.role === "assistant")
          .map((m) => ({ role: m.role as "user" | "assistant", content: m.content })),
      );
    } catch (error) {
      console.error("[ai-conversation] failed to load thread", error);
      if (requestedScope === scopeKeyRef.current) {
        setConversationId(null);
        setHistory([]);
      }
    } finally {
      setIsLoadingHistory(false);
    }
  }, [organizationId, businessId, effectiveBranchId, appKey]);

  useEffect(() => {
    void resolve();
  }, [resolve]);

  const ensureConversation = useCallback(
    async (firstMessage: string) => {
      if (conversationId) return conversationId;
      if (!organizationId) return null;
      const { data: userData } = await supabase.auth.getUser();
      const userId = userData?.user?.id;
      if (!userId) return null;

      const { data, error } = await supabase
        .from("ai_conversations")
        .insert({
          organization_id: organizationId,
          business_id: businessId,
          branch_id: effectiveBranchId,
          app_key: appKey,
          module_key: moduleKey,
          scope_level: scopeLevel(scope),
          created_by: userId,
          title: firstMessage.slice(0, 80),
        })
        .select("id")
        .single();

      if (error) {
        console.error("[ai-conversation] failed to create thread", error);
        return null;
      }
      setConversationId(data.id);
      return data.id;
    },
    [conversationId, organizationId, businessId, effectiveBranchId, appKey, moduleKey, scope],
  );

  const archiveConversation = useCallback(async () => {
    if (!conversationId) {
      setHistory([]);
      return;
    }
    const { error } = await supabase
      .from("ai_conversations")
      .update({ archived_at: new Date().toISOString() })
      .eq("id", conversationId);
    if (error) console.error("[ai-conversation] failed to archive thread", error);
    setConversationId(null);
    setHistory([]);
  }, [conversationId]);

  return {
    conversationId,
    history,
    isLoadingHistory,
    ensureConversation,
    archiveConversation,
    reload: resolve,
  };
}
