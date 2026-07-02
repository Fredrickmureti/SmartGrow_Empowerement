/**
 * useAIInsightsCache Hook
 * 
 * Manages persistent storage of AI-generated insights and suggestions
 * in Supabase for cross-session persistence, scoped by business context.
 */

import { useState, useEffect, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useSession } from "@/contexts/SessionContext";
import { useAuth } from "@/contexts/AuthContext";
import { useBusinesses } from "@/hooks/useBusinesses";

export type InsightType = "financial_insights" | "suggestions";

interface UseAIInsightsCacheOptions {
  insightType: InsightType;
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

export function useAIInsightsCache<T>({ 
  insightType 
}: UseAIInsightsCacheOptions): UseAIInsightsCacheResult<T> {
  const { currentOrg } = useSession();
  const { user } = useAuth();
  const { currentBusiness } = useBusinesses();
  const businessId = currentBusiness?.id || null;

  const [cachedContent, setCachedContent] = useState<T | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [updatedAt, setUpdatedAt] = useState<Date | null>(null);

  // Reset state when business context changes
  useEffect(() => {
    setCachedContent(null);
    setUpdatedAt(null);
    setIsLoading(true);
  }, [businessId]);

  // Load cached content scoped by business
  useEffect(() => {
    const loadCache = async () => {
      if (!currentOrg?.id || !user?.id) {
        setIsLoading(false);
        return;
      }

      try {
        let query = supabase
          .from("ai_insights_cache")
          .select("content, updated_at")
          .eq("organization_id", currentOrg.id)
          .eq("user_id", user.id)
          .eq("insight_type", insightType);

        if (businessId) {
          query = query.eq("business_id", businessId);
        } else {
          query = query.is("business_id", null);
        }

        const { data, error } = await query.maybeSingle();

        if (error) {
          console.error("Error loading AI insights cache:", error);
        } else if (data) {
          setCachedContent(data.content as T);
          setUpdatedAt(new Date(data.updated_at));
        }
      } catch (err) {
        console.error("Failed to load AI insights cache:", err);
      } finally {
        setIsLoading(false);
      }
    };

    loadCache();
  }, [currentOrg?.id, user?.id, insightType, businessId]);

  const saveToCache = useCallback(async (content: T) => {
    if (!currentOrg?.id || !user?.id) return;

    setIsSaving(true);
    try {
      const record: any = {
        organization_id: currentOrg.id,
        user_id: user.id,
        insight_type: insightType,
        content: content as any,
        updated_at: new Date().toISOString(),
        business_id: businessId,
      };

      // We can't use onConflict with the COALESCE index directly,
      // so delete-then-insert to handle the NULL business_id case
      let deleteQuery = supabase
        .from("ai_insights_cache")
        .delete()
        .eq("organization_id", currentOrg.id)
        .eq("user_id", user.id)
        .eq("insight_type", insightType);

      if (businessId) {
        deleteQuery = deleteQuery.eq("business_id", businessId);
      } else {
        deleteQuery = deleteQuery.is("business_id", null);
      }

      await deleteQuery;

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
  }, [currentOrg?.id, user?.id, insightType, businessId]);

  const clearCache = useCallback(async () => {
    if (!currentOrg?.id || !user?.id) return;

    try {
      let query = supabase
        .from("ai_insights_cache")
        .delete()
        .eq("organization_id", currentOrg.id)
        .eq("user_id", user.id)
        .eq("insight_type", insightType);

      if (businessId) {
        query = query.eq("business_id", businessId);
      } else {
        query = query.is("business_id", null);
      }

      const { error } = await query;

      if (error) {
        console.error("Error clearing AI insights cache:", error);
      } else {
        setCachedContent(null);
        setUpdatedAt(null);
      }
    } catch (err) {
      console.error("Failed to clear AI insights cache:", err);
    }
  }, [currentOrg?.id, user?.id, insightType, businessId]);

  return {
    cachedContent,
    isLoading,
    isSaving,
    saveToCache,
    clearCache,
    updatedAt,
  };
}
