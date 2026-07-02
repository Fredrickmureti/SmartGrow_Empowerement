/**
 * useSelfieSignedUrl — short-lived signed URL for an attendance selfie object.
 * Tries the `attendance-selfies` bucket; returns null silently if the bucket
 * or object is missing so callers can degrade gracefully.
 */
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";

const BUCKET = "attendance-selfies";

export function useSelfieSignedUrl(path: string | null | undefined) {
  return useQuery({
    queryKey: ["attendance-selfie-url", path],
    enabled: !!path,
    staleTime: 1000 * 50,
    retry: false,
    queryFn: async (): Promise<string | null> => {
      if (!path) return null;
      const { data, error } = await supabase.storage.from(BUCKET).createSignedUrl(path, 60);
      if (error) return null;
      return data?.signedUrl ?? null;
    },
  });
}
