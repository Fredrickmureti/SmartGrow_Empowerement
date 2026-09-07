/**
 * Retired: the SaaS marketing "demo videos" library.
 *
 * `platform_demo_videos` was part of the inherited multi-tenant ERP/SaaS
 * marketing surface and has been dropped from the database. Smart Grow
 * Empowerment is a single institution, not a SaaS product, so there is no
 * demo-video catalogue to administer.
 *
 * The hook is kept as an inert stub so the Resource Center launcher keeps
 * compiling and simply renders no videos. Delete it together with the
 * launcher's video section when the Resource Center is reworked.
 */
import { useCallback } from "react";

export type DemoVideoAudience = "public" | "authenticated";
export type DemoVideoDifficulty = "intro" | "deep-dive";

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
  app_key: string | null;
  audience: DemoVideoAudience;
  difficulty: DemoVideoDifficulty | null;
}

export interface CreateDemoVideoInput {
  title: string;
  description?: string;
  video_url: string;
  thumbnail_url?: string;
  category?: string;
  duration_seconds?: number;
  is_published?: boolean;
  app_key?: string | null;
  audience?: DemoVideoAudience;
  difficulty?: DemoVideoDifficulty | null;
}

const NO_VIDEOS: DemoVideo[] = [];

export function useDemoVideos(_publicOnly = false) {
  const noop = useCallback(async () => {}, []);

  return {
    videos: NO_VIDEOS,
    isLoading: false,
    isSaving: false,
    fetchVideos: noop,
    createVideo: async (_input: CreateDemoVideoInput): Promise<DemoVideo | null> => null,
    updateVideo: async (_id: string, _updates: Partial<CreateDemoVideoInput>) => {},
    deleteVideo: async (_id: string) => {},
    reorderVideos: async (_videos: DemoVideo[]) => {},
    togglePublish: async (_id: string) => {},
  };
}
