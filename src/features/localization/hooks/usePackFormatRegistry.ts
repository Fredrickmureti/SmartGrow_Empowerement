/**
 * usePackFormatRegistry — reads the canonical `public.format_registry`
 * whitelist. Publishers pick from this list; the DB trigger
 * `assert_outputs_formats_registered` rejects saves that reference an
 * unregistered format. Public-read RLS on the table means no auth is
 * needed. Cached indefinitely inside the session — the row set only
 * changes with a platform release, not a tenant action.
 */
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";

export interface PackFormat {
  format: string;
  label: string;
  mime: string;
  ext: string;
  role_hint: "primary" | "human_readable" | "audit" | "portal";
  writer: string;
}

export function usePackFormatRegistry() {
  return useQuery({
    queryKey: ["localization", "format-registry"],
    staleTime: Infinity,
    queryFn: async () => {
      const { data, error } = await (supabase as any)
        .from("format_registry")
        .select("format, label, mime, ext, role_hint, writer")
        .order("label");
      if (error) throw error;
      return (data ?? []) as PackFormat[];
    },
  });
}