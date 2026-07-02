import { useState, useEffect, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { normalizeError } from "@/services/resilience";

export interface DemoVideo {
  id: string;
  title: string;
  description: string | null;
  video_url: string;
  thumbnail_url: string | null;
  category: string;
  duration_seconds: number | null;
  sort_order: number;
  is_published: boolean;
  published_at: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface CreateDemoVideoInput {
  title: string;
  description?: string;
  video_url: string;
  thumbnail_url?: string;
  category?: string;
  duration_seconds?: number;
  is_published?: boolean;
}

export function useDemoVideos(publicOnly = false) {
  const [videos, setVideos] = useState<DemoVideo[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);

  const fetchVideos = useCallback(async () => {
    try {
      setIsLoading(true);
      let query = supabase
        .from("platform_demo_videos")
        .select("*")
        .order("sort_order", { ascending: true });

      if (publicOnly) {
        query = query.eq("is_published", true);
      }

      const { data, error } = await query;

      if (error) throw error;
      setVideos((data as DemoVideo[]) || []);
    } catch (error: any) {
      console.error("Error fetching demo videos:", error);
      if (!publicOnly) {
        toast.error("Failed to load demo videos");
      }
    } finally {
      setIsLoading(false);
    }
  }, [publicOnly]);

  useEffect(() => {
    fetchVideos();
  }, [fetchVideos]);

  const createVideo = async (input: CreateDemoVideoInput) => {
    try {
      setIsSaving(true);
      
      const { data: userData } = await supabase.auth.getUser();
      
      // Get max sort_order
      const maxOrder = videos.length > 0 
        ? Math.max(...videos.map(v => v.sort_order)) 
        : -1;

      const { data, error } = await supabase
        .from("platform_demo_videos")
        .insert({
          ...input,
          sort_order: maxOrder + 1,
          created_by: userData.user?.id,
          published_at: input.is_published ? new Date().toISOString() : null,
        })
        .select()
        .single();

      if (error) throw error;
      
      toast.success("Demo video added successfully");
      await fetchVideos();
      return data as DemoVideo;
    } catch (error: any) {
      console.error("Error creating demo video:", error);
      toast.error(normalizeError(error).message || "Failed to add demo video");
      throw error;
    } finally {
      setIsSaving(false);
    }
  };

  const updateVideo = async (id: string, updates: Partial<CreateDemoVideoInput>) => {
    try {
      setIsSaving(true);
      
      const updateData: any = { ...updates };
      
      // Set published_at when publishing
      if (updates.is_published === true) {
        const video = videos.find(v => v.id === id);
        if (video && !video.is_published) {
          updateData.published_at = new Date().toISOString();
        }
      }

      const { error } = await supabase
        .from("platform_demo_videos")
        .update(updateData)
        .eq("id", id);

      if (error) throw error;
      
      toast.success("Demo video updated");
      await fetchVideos();
    } catch (error: any) {
      console.error("Error updating demo video:", error);
      toast.error(normalizeError(error).message || "Failed to update demo video");
      throw error;
    } finally {
      setIsSaving(false);
    }
  };

  const deleteVideo = async (id: string) => {
    try {
      setIsSaving(true);
      
      const { error } = await supabase
        .from("platform_demo_videos")
        .delete()
        .eq("id", id);

      if (error) throw error;
      
      toast.success("Demo video deleted");
      await fetchVideos();
    } catch (error: any) {
      console.error("Error deleting demo video:", error);
      toast.error(normalizeError(error).message || "Failed to delete demo video");
      throw error;
    } finally {
      setIsSaving(false);
    }
  };

  const reorderVideos = async (reorderedVideos: DemoVideo[]) => {
    try {
      setIsSaving(true);
      
      // Update sort_order for each video
      for (let i = 0; i < reorderedVideos.length; i++) {
        const { error } = await supabase
          .from("platform_demo_videos")
          .update({ sort_order: i })
          .eq("id", reorderedVideos[i].id);

        if (error) throw error;
      }
      
      setVideos(reorderedVideos.map((v, i) => ({ ...v, sort_order: i })));
      toast.success("Video order updated");
    } catch (error: any) {
      console.error("Error reordering videos:", error);
      toast.error("Failed to reorder videos");
      await fetchVideos(); // Refresh to get actual order
    } finally {
      setIsSaving(false);
    }
  };

  const togglePublish = async (id: string) => {
    const video = videos.find(v => v.id === id);
    if (!video) return;
    
    await updateVideo(id, { is_published: !video.is_published });
  };

  return {
    videos,
    isLoading,
    isSaving,
    fetchVideos,
    createVideo,
    updateVideo,
    deleteVideo,
    reorderVideos,
    togglePublish,
  };
}
