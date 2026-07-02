/**
 * useAttendanceSavedViews — per-user filter presets for Today, Approvals, Reports.
 * Backed by public.attendance_saved_views (RLS scoped to auth.uid()).
 */
import { useMemo } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useBusinesses } from "@/hooks/useBusinesses";

export type SavedViewScope = "today" | "approvals" | "reports";

export interface SavedView {
  id: string;
  user_id: string;
  business_id: string | null;
  scope: SavedViewScope;
  name: string;
  filters: Record<string, unknown>;
  is_default: boolean;
  created_at: string;
  updated_at: string;
}

export function useAttendanceSavedViews(scope: SavedViewScope) {
  const qc = useQueryClient();
  const { currentBusiness } = useBusinesses();
  const businessId = currentBusiness?.id ?? null;
  const queryKey = ["attendance-saved-views", scope, businessId];

  const { data: views = [], isLoading } = useQuery({
    queryKey,
    queryFn: async () => {
      let q = supabase
        .from("attendance_saved_views" as any)
        .select("*")
        .eq("scope", scope);
      if (businessId) q = q.eq("business_id", businessId);
      else q = q.is("business_id", null);
      const { data, error } = await q.order("created_at", { ascending: true });
      if (error) throw error;
      return (data as unknown as SavedView[]) ?? [];
    },
  });

  const defaultView = useMemo(
    () => views.find((v) => v.is_default) ?? null,
    [views],
  );

  const invalidate = () => qc.invalidateQueries({ queryKey });

  const save = useMutation({
    mutationFn: async (input: {
      name: string;
      filters: Record<string, unknown>;
      isDefault?: boolean;
    }) => {
      const userRes = await supabase.auth.getUser();
      const userId = userRes.data.user?.id;
      if (!userId) throw new Error("Not signed in");
      // If marking default, clear other defaults first
      if (input.isDefault) {
        await supabase
          .from("attendance_saved_views" as any)
          .update({ is_default: false } as any)
          .eq("user_id", userId)
          .eq("scope", scope);
      }
      const { data, error } = await supabase
        .from("attendance_saved_views" as any)
        .insert({
          user_id: userId,
          business_id: businessId,
          scope,
          name: input.name,
          filters: input.filters as any,
          is_default: !!input.isDefault,
        } as any)
        .select()
        .single();
      if (error) throw error;
      return data as unknown as SavedView;
    },
    onSuccess: invalidate,
  });

  const remove = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase
        .from("attendance_saved_views" as any)
        .delete()
        .eq("id", id);
      if (error) throw error;
    },
    onSuccess: invalidate,
  });

  const setDefault = useMutation({
    mutationFn: async (id: string) => {
      const userRes = await supabase.auth.getUser();
      const userId = userRes.data.user?.id;
      if (!userId) throw new Error("Not signed in");
      await supabase
        .from("attendance_saved_views" as any)
        .update({ is_default: false } as any)
        .eq("user_id", userId)
        .eq("scope", scope);
      const { error } = await supabase
        .from("attendance_saved_views" as any)
        .update({ is_default: true } as any)
        .eq("id", id);
      if (error) throw error;
    },
    onSuccess: invalidate,
  });

  return { views, defaultView, isLoading, save, remove, setDefault };
}
