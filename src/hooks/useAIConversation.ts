/**
 * Conversation binding for the AI assistant.
 *
 * A thread belongs to exactly one (organization, business, branch?, app) scope.
 * Switching tenant, business, branch, app, or scope mode rebinds to a
 * different thread — conversations never bleed across scopes, and history is
 * reloaded from the database rather than carried in volatile React state.
 *
 * Every query below carries an explicit `organization_id` predicate (or is
 * keyed by a `conversation_id` already resolved under one); RLS is the
 * enforcement point, this is defence in depth.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import type { ScopeMode } from "@/lib/ai/workingContext";

export interface StoredMessage {
  role: "user" | "assistant";
  content: string;
}

export interface ConversationSummary {
  id: string;
  title: string | null;
  lastMessageAt: string | null;
  createdAt: string;
}

export interface ConversationScope {
  organizationId: string | null | undefined;
  businessId: string | null;
  branchId: string | null | undefined;
  appKey: string;
  moduleKey: string | null;
  scopeMode: ScopeMode;
  /** Record the user is looking at; only used when `scopeMode` is "record". */
  recordType?: string | null;
  recordId?: string | null;
}

interface UseAIConversationResult {
  conversationId: string | null;
  history: StoredMessage[];
  isLoadingHistory: boolean;
  /** Threads that exist in the current scope, newest first. */
  conversations: ConversationSummary[];
  /** Creates the thread on first send and returns its id. */
  ensureConversation: (firstMessage: string) => Promise<string | null>;
  /** Archives the current thread and starts an empty one in the same scope. */
  archiveConversation: () => Promise<void>;
  /** Leaves the current thread bound but unselected — the next turn opens a new one. */
  startNewConversation: () => void;
  /** Binds an existing thread from the same scope and loads its history. */
  selectConversation: (id: string) => Promise<void>;
  reload: () => Promise<void>;
}

function scopeLevel(
  scope: ConversationScope,
): "record" | "branch" | "business" | "organization" {
  if (scope.scopeMode === "record" && scope.recordId) return "record";
  if (scope.scopeMode === "branch" && scope.branchId) return "branch";
  return scope.businessId ? "business" : "organization";
}

const HISTORY_LIMIT = 100;
const THREAD_LIST_LIMIT = 20;

export function useAIConversation(scope: ConversationScope): UseAIConversationResult {
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [history, setHistory] = useState<StoredMessage[]>([]);
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [isLoadingHistory, setIsLoadingHistory] = useState(false);

  const {
    organizationId,
    businessId,
    branchId,
    appKey,
    moduleKey,
    scopeMode,
    recordType,
    recordId,
  } = scope;
  const effectiveBranchId = scopeMode === "branch" ? branchId ?? null : null;
  // Record threads live beside the app's other threads but never mix with
  // them: a scope-level thread carries NULL record columns, a record thread
  // carries both. The list query is null-aware on both sides.
  const effectiveRecordId = scopeMode === "record" ? recordId ?? null : null;
  const effectiveRecordType = effectiveRecordId ? recordType ?? null : null;
  const scopeKey = [
    organizationId,
    businessId,
    effectiveBranchId,
    appKey,
    scopeMode,
    effectiveRecordId,
  ].join("|");
  const scopeKeyRef = useRef(scopeKey);
  scopeKeyRef.current = scopeKey;

  const loadMessages = useCallback(async (threadId: string) => {
    const { data, error } = await supabase
      .from("ai_conversation_messages")
      .select("role, content")
      .eq("conversation_id", threadId)
      .order("created_at", { ascending: true })
      .limit(HISTORY_LIMIT);
    if (error) throw error;
    return (data ?? [])
      .filter((m) => m.role === "user" || m.role === "assistant")
      .map((m) => ({ role: m.role as "user" | "assistant", content: m.content }));
  }, []);

  const resolve = useCallback(async () => {
    if (!organizationId) {
      setConversationId(null);
      setHistory([]);
      setConversations([]);
      return;
    }
    const requestedScope = scopeKeyRef.current;
    setIsLoadingHistory(true);
    try {
      let query = supabase
        .from("ai_conversations")
        .select("id, title, last_message_at, created_at")
        .eq("organization_id", organizationId)
        .eq("app_key", appKey)
        .is("archived_at", null)
        .order("last_message_at", { ascending: false, nullsFirst: false })
        .order("created_at", { ascending: false })
        .limit(THREAD_LIST_LIMIT);

      query = businessId
        ? query.eq("business_id", businessId)
        : query.is("business_id", null);
      query = effectiveBranchId
        ? query.eq("branch_id", effectiveBranchId)
        : query.is("branch_id", null);
      query = effectiveRecordId
        ? query.eq("record_id", effectiveRecordId)
        : query.is("record_id", null);

      const { data: rows, error } = await query;
      if (error) throw error;
      // A scope switch may have landed while this query was in flight.
      if (requestedScope !== scopeKeyRef.current) return;

      const summaries: ConversationSummary[] = (rows ?? []).map((r) => ({
        id: r.id,
        title: r.title,
        lastMessageAt: r.last_message_at,
        createdAt: r.created_at,
      }));
      setConversations(summaries);

      const found = summaries[0]?.id ?? null;
      setConversationId(found);

      if (!found) {
        setHistory([]);
        return;
      }
      const messages = await loadMessages(found);
      if (requestedScope !== scopeKeyRef.current) return;
      setHistory(messages);
    } catch (error) {
      console.error("[ai-conversation] failed to load thread", error);
      if (requestedScope === scopeKeyRef.current) {
        setConversationId(null);
        setHistory([]);
        setConversations([]);
      }
    } finally {
      setIsLoadingHistory(false);
    }
  }, [organizationId, businessId, effectiveBranchId, effectiveRecordId, appKey, loadMessages]);

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
          record_type: effectiveRecordType,
          record_id: effectiveRecordId,
          scope_level: scopeLevel(scope),
          created_by: userId,
          title: firstMessage.slice(0, 80),
        })
        .select("id, title, last_message_at, created_at")
        .single();

      if (error) {
        console.error("[ai-conversation] failed to create thread", error);
        return null;
      }
      setConversationId(data.id);
      setConversations((prev) => [
        {
          id: data.id,
          title: data.title,
          lastMessageAt: data.last_message_at,
          createdAt: data.created_at,
        },
        ...prev.filter((c) => c.id !== data.id),
      ]);
      return data.id;
    },
    [
      conversationId,
      organizationId,
      businessId,
      effectiveBranchId,
      effectiveRecordType,
      effectiveRecordId,
      appKey,
      moduleKey,
      scope,
    ],
  );

  const archiveConversation = useCallback(async () => {
    if (!conversationId) {
      setHistory([]);
      return;
    }
    const archivedId = conversationId;
    const { error } = await supabase
      .from("ai_conversations")
      .update({ archived_at: new Date().toISOString() })
      .eq("id", archivedId);
    if (error) console.error("[ai-conversation] failed to archive thread", error);
    setConversations((prev) => prev.filter((c) => c.id !== archivedId));
    setConversationId(null);
    setHistory([]);
  }, [conversationId]);

  const startNewConversation = useCallback(() => {
    // The thread row is created lazily on the next send so navigating around
    // never litters the list with empty threads.
    setConversationId(null);
    setHistory([]);
  }, []);

  const selectConversation = useCallback(
    async (id: string) => {
      const requestedScope = scopeKeyRef.current;
      setIsLoadingHistory(true);
      try {
        const messages = await loadMessages(id);
        if (requestedScope !== scopeKeyRef.current) return;
        setConversationId(id);
        setHistory(messages);
      } catch (error) {
        console.error("[ai-conversation] failed to open thread", error);
      } finally {
        setIsLoadingHistory(false);
      }
    },
    [loadMessages],
  );

  return useMemo(
    () => ({
      conversationId,
      history,
      isLoadingHistory,
      conversations,
      ensureConversation,
      archiveConversation,
      startNewConversation,
      selectConversation,
      reload: resolve,
    }),
    [
      conversationId,
      history,
      isLoadingHistory,
      conversations,
      ensureConversation,
      archiveConversation,
      startNewConversation,
      selectConversation,
      resolve,
    ],
  );
}
