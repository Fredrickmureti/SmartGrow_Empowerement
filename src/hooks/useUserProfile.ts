import { useState, useEffect, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import { toast } from "sonner";
import { normalizeError } from "@/services/resilience";

export interface UserProfile {
  id: string;
  user_id: string;
  full_name: string | null;
  avatar_url: string | null;
  phone: string | null;
  email: string;
}

export function useUserProfile() {
  const { user } = useAuth();
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  const fetchProfile = useCallback(async () => {
    if (!user) {
      setProfile(null);
      setIsLoading(false);
      return;
    }

    try {
      const { data, error } = await supabase
        .from("profiles")
        .select("id, user_id, full_name, avatar_url, phone, email")
        .eq("user_id", user.id)
        .maybeSingle();

      if (error) throw error;
      setProfile(data as UserProfile | null);
    } catch (error) {
      console.error("Error fetching user profile:", error);
    } finally {
      setIsLoading(false);
    }
  }, [user?.id]);

  useEffect(() => {
    fetchProfile();
  }, [fetchProfile]);

  const updateProfile = useCallback(async (updates: Partial<Pick<UserProfile, "full_name" | "phone" | "avatar_url">>) => {
    if (!user) return;
    try {
      const { error } = await supabase
        .from("profiles")
        .update(updates)
        .eq("user_id", user.id);

      if (error) throw error;
      setProfile(prev => prev ? { ...prev, ...updates } : null);
      toast.success("Profile updated");
    } catch (error: any) {
      toast.error(normalizeError(error).message || "Failed to update profile");
      throw error;
    }
  }, [user?.id]);

  return { profile, isLoading, updateProfile, refreshProfile: fetchProfile };
}
