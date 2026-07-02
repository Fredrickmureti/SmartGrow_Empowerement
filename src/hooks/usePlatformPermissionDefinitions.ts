import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";

export interface PermissionDefinition {
  key: string;
  label: string;
  category: string;
  description: string | null;
  sort_order: number;
}

export function usePlatformPermissionDefinitions() {
  return useQuery({
    queryKey: ["platform-permission-definitions"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("platform_permission_definitions")
        .select("*")
        .order("sort_order");
      if (error) throw error;
      return data as PermissionDefinition[];
    },
    staleTime: 5 * 60 * 1000, // 5 min cache
  });
}

/** Group permission definitions by category */
export function groupByCategory(definitions: PermissionDefinition[]): Record<string, PermissionDefinition[]> {
  const grouped: Record<string, PermissionDefinition[]> = {};
  for (const def of definitions) {
    if (!grouped[def.category]) grouped[def.category] = [];
    grouped[def.category].push(def);
  }
  return grouped;
}
