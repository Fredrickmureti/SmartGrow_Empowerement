/**
 * useAIInsightsCache Hook
 *
 * Manages persistent storage of AI-generated insights and suggestions
 * in Supabase for cross-session persistence.
 *
 * Scope keying (Phase 4 of the AI conversation scope architecture):
 * a cache row belongs to exactly one
 * (organization, user, insight_type, business, branch|company, app) tuple.
 * Switching organization, business, branch or application therefore never
 * shows another scope's cached insight.
 */

import { useState, useEffect, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useSession } from "@/contexts/SessionContext";
import { useAuth } from "@/contexts/AuthContext";
import { useBusinesses } from "@/hooks/useBusinesses";
import { useBranch } from "@/contexts/BranchContext";

export type InsightType = "financial_insights" | "suggestions";

interface UseAIInsightsCacheOptions {
  insightType: InsightType;
  /**
   * Optional application key the insight belongs to. Omit for
   * cross-application (workspace level) insights.
   */
  appKey?: string | null;
  /**
   * "branch" (default) keys the cache to the active branch;
   * "company" keys it to the business as a whole.
   */
  scopeMode?: "branch" | "company";
}

interface UseAIInsightsCacheResult<T> {
  /** Cached content from database */
  cachedContent: T | null;
  /** Whether initial load is in progress */
  isLoading: boolean;
  /** Whether save is in progress */
  isSaving: boolean;
  /** Save new content to cache */
  saveToCache: (content: T) => Promise<void>;
  /** Clear cached content */
  clearCache: () => Promise<void>;
  /** Last updated timestamp */
  updatedAt: Date | null;
}

/** Minimal structural shape shared by PostgREST select/delete builders. */
interface ScopeFilterable {
  eq(column: string, value: string): ScopeFilterable;
  is(column: string, value: null): ScopeFilterable;
}

export function useAIInsightsCache<T>({
  insightType,
  appKey = null,
  scopeMode = "branch",
}: UseAIInsightsCacheOptions): UseAIInsightsCacheResult<T> {
  const { currentOrg } = useSession();
  const { user } = useAuth();
  const { currentBusiness } = useBusinesses();
  const { currentBranch } = useBranch();

  const businessId = currentBusiness?.id || null;
  const branchId = scopeMode === "branch" ? currentBranch?.id || null : null;
  const scopedAppKey = appKey || null;

  const [cachedContent, setCachedContent] = useState<T | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [updatedAt, setUpdatedAt] = useState<Date | null>(null);

  // Any scope change invalidates the currently displayed cache entry.
  useEffect(() => {
    setCachedContent(null);
    setUpdatedAt(null);
    setIsLoading(true);
  }, [currentOrg?.id, businessId, branchId, scopedAppKey, insightType]);

  // Apply the full scope tuple to a select/delete builder.
  const applyScope = useCallback(
    <Q>(query: Q): Q => {
      let q = query as unknown as ScopeFilterable;
      q = businessId ? q.eq("business_id", businessId) : q.is("business_id", null);
      q = branchId ? q.eq("branch_id", branchId) : q.is("branch_id", null);
      q = scopedAppKey ? q.eq("app_key", scopedAppKey) : q.is("app_key", null);
      return q as unknown as Q;
    },
    [businessId, branchId, scopedAppKey]
  );

  // Load cached content for the active scope
  useEffect(() => {
    let cancelled = false;
    const scopeKey = `${currentOrg?.id}|${businessId}|${branchId}|${scopedAppKey}|${insightType}`;

    const loadCache = async () => {
      if (!currentOrg?.id || !user?.id) {
        if (!cancelled) setIsLoading(false);
        return;
      }

      try {
        const query = applyScope(
          supabase
            .from("ai_insights_cache")
            .select("content, updated_at")
            .eq("organization_id", currentOrg.id)
            .eq("user_id", user.id)
            .eq("insight_type", insightType)
        );

        const { data, error } = await query.maybeSingle();
        if (cancelled) return;

        if (error) {
          console.error("Error loading AI insights cache:", error);
        } else if (data) {
          setCachedContent(data.content as T);
          setUpdatedAt(new Date(data.updated_at));
        }
      } catch (err) {
        if (!cancelled) console.error("Failed to load AI insights cache:", err);
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    };

    void scopeKey;
    loadCache();

    return () => {
      cancelled = true;
    };
  }, [currentOrg?.id, user?.id, insightType, businessId, branchId, scopedAppKey, applyScope]);

  const saveToCache = useCallback(
    async (content: T) => {
      if (!currentOrg?.id || !user?.id) return;

      setIsSaving(true);
      try {
        const record = {
          organization_id: currentOrg.id,
          user_id: user.id,
          insight_type: insightType,
          content: content as unknown as never,
          updated_at: new Date().toISOString(),
          business_id: businessId,
          branch_id: branchId,
          app_key: scopedAppKey,
        };

        // The unique index uses COALESCE over the nullable scope columns, so we
        // cannot use onConflict here — delete the exact scope row then insert.
        await applyScope(
          supabase
            .from("ai_insights_cache")
            .delete()
            .eq("organization_id", currentOrg.id)
            .eq("user_id", user.id)
            .eq("insight_type", insightType)
        );

        const { error } = await supabase
          // SCOPE-EXEMPT: "ai_insights_cache" is workspace-wide (not in BUSINESS_SCOPED_TABLES)
          .from("ai_insights_cache")
          .insert(record);

        if (error) {
          console.error("Error saving AI insights cache:", error);
        } else {
          setCachedContent(content);
          setUpdatedAt(new Date());
        }
      } catch (err) {
        console.error("Failed to save AI insights cache:", err);
      } finally {
        setIsSaving(false);
      }
    },
    [currentOrg?.id, user?.id, insightType, businessId, branchId, scopedAppKey, applyScope]
  );

  const clearCache = useCallback(async () => {
    if (!currentOrg?.id || !user?.id) return;

    try {
      const { error } = await applyScope(
        supabase
          .from("ai_insights_cache")
          .delete()
          .eq("organization_id", currentOrg.id)
          .eq("user_id", user.id)
          .eq("insight_type", insightType)
      );

      if (error) {
        console.error("Error clearing AI insights cache:", error);
      } else {
        setCachedContent(null);
        setUpdatedAt(null);
      }
    } catch (err) {
      console.error("Failed to clear AI insights cache:", err);
    }
  }, [currentOrg?.id, user?.id, insightType, applyScope]);

  return {
    cachedContent,
    isLoading,
    isSaving,
    saveToCache,
    clearCache,
    updatedAt,
  };
}
