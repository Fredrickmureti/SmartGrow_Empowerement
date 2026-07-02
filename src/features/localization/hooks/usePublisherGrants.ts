/**
 * usePublisherGrants — publisher governance hooks.
 *
 * Surfaces `pack_publisher_grants` for the publisher organisation that owns
 * a given pack. All writes go through RLS — only platform admins or existing
 * `owner` grantees can mutate, so the UI does not gate by role itself.
 *
 * Role taxonomy (matches DB CHECK constraint):
 *   - owner     : full control, can grant/revoke (incl. other owners), publish
 *   - publisher : authors and publishes pack content, cannot manage grantees
 *   - reviewer  : read + comment surface (future 4-eyes flow); cannot write rules
 *
 * Adding a publisher is keyed by email — we resolve via `profiles.email`
 * server-side so callers do not need direct auth.users access.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";

export type PublisherGrantRole = "owner" | "publisher" | "reviewer";

export interface PublisherGrant {
  id: string;
  publisher_org_id: string;
  user_id: string;
  role: PublisherGrantRole;
  created_at: string;
  created_by: string | null;
  // joined profile fields (best-effort; null when profile not visible to caller)
  email?: string | null;
  full_name?: string | null;
}

/**
 * Grants for the publisher org that owns `packId`. Returns [] when the
 * pack has no `publisher_org_id` (platform-owned pack).
 */
export function usePublisherGrants(packId?: string | null) {
  return useQuery({
    queryKey: ["pack-publisher-grants", packId],
    enabled: !!packId,
    queryFn: async (): Promise<{ publisherOrgId: string | null; grants: PublisherGrant[] }> => {
      const { data: pack, error: packErr } = await (supabase as any)
        .from("localization_packs")
        .select("publisher_org_id")
        .eq("id", packId)
        .maybeSingle();
      if (packErr) throw packErr;
      const publisherOrgId = pack?.publisher_org_id ?? null;
      if (!publisherOrgId) return { publisherOrgId: null, grants: [] };

      const { data: grantRows, error: grantsErr } = await (supabase as any)
        .from("pack_publisher_grants")
        .select("id, publisher_org_id, user_id, role, created_at, created_by")
        .eq("publisher_org_id", publisherOrgId)
        .order("created_at", { ascending: true });
      if (grantsErr) throw grantsErr;
      const grants = (grantRows ?? []) as PublisherGrant[];
      const userIds = Array.from(new Set(grants.map((g) => g.user_id)));
      if (userIds.length === 0) return { publisherOrgId, grants };

      const { data: profiles } = await (supabase as any)
        .from("profiles")
        .select("user_id, email, full_name")
        .in("user_id", userIds);
      const byUser = new Map<string, { email: string | null; full_name: string | null }>();
      for (const p of (profiles ?? []) as any[]) {
        byUser.set(p.user_id, { email: p.email ?? null, full_name: p.full_name ?? null });
      }
      return {
        publisherOrgId,
        grants: grants.map((g) => ({ ...g, ...(byUser.get(g.user_id) ?? {}) })),
      };
    },
  });
}

export function useAddPublisherGrant() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      publisher_org_id: string;
      email: string;
      role: PublisherGrantRole;
      pack_id: string; // for cache invalidation
    }) => {
      const email = input.email.trim().toLowerCase();
      const { data: profile, error: lookupErr } = await (supabase as any)
        .from("profiles")
        .select("user_id, email")
        .ilike("email", email)
        .maybeSingle();
      if (lookupErr) throw lookupErr;
      if (!profile?.user_id) {
        throw new Error(
          `No user with email "${input.email}" has signed in yet. Ask them to log in once so a profile exists, then re-invite.`,
        );
      }
      const { data: { user } } = await supabase.auth.getUser();
      const { data, error } = await (supabase as any)
        .from("pack_publisher_grants")
        .insert({
          publisher_org_id: input.publisher_org_id,
          user_id: profile.user_id,
          role: input.role,
          created_by: user?.id ?? null,
        })
        .select()
        .single();
      if (error) throw error;
      return data as PublisherGrant;
    },
    onSuccess: (_d, vars) => {
      qc.invalidateQueries({ queryKey: ["pack-publisher-grants", vars.pack_id] });
    },
  });
}

export function useUpdatePublisherGrant() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { id: string; role: PublisherGrantRole; pack_id: string }) => {
      const { data, error } = await (supabase as any)
        .from("pack_publisher_grants")
        .update({ role: input.role })
        .eq("id", input.id)
        .select()
        .single();
      if (error) throw error;
      return data as PublisherGrant;
    },
    onSuccess: (_d, vars) => {
      qc.invalidateQueries({ queryKey: ["pack-publisher-grants", vars.pack_id] });
    },
  });
}

export function useRemovePublisherGrant() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { id: string; pack_id: string }) => {
      const { error } = await (supabase as any)
        .from("pack_publisher_grants")
        .delete()
        .eq("id", input.id);
      if (error) throw error;
    },
    onSuccess: (_d, vars) => {
      qc.invalidateQueries({ queryKey: ["pack-publisher-grants", vars.pack_id] });
    },
  });
}
