/**
 * useActorNames — resolve auth user ids to display names.
 *
 * Audit surfaces store `auth.users.id` (created_by, approved_by,
 * actor_user_id, …). Those live in `profiles.user_id`, NEVER `profiles.id`
 * (see mem://constraints/profiles-lookup-key) — joining on the surrogate key
 * silently returns nothing and the UI prints raw UUIDs.
 *
 * Read-only and RLS-safe: it selects the same three columns every other
 * actor-resolution surface in the ERP already selects.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { supabase } from "@/integrations/supabase/client";

interface ProfileRow {
  user_id: string;
  full_name: string | null;
  email: string | null;
}

export function useActorNames(userIds: (string | null | undefined)[]) {
  const ids = useMemo(
    () =>
      Array.from(
        new Set(userIds.filter((v): v is string => Boolean(v))),
      ).sort(),
    [userIds],
  );
  const key = ids.join(",");
  const [profiles, setProfiles] = useState<ProfileRow[]>([]);

  useEffect(() => {
    let cancelled = false;
    if (ids.length === 0) {
      setProfiles([]);
      return;
    }
    void (async () => {
      const { data } = await supabase
        .from("profiles")
        .select("user_id, full_name, email")
        .in("user_id", ids);
      if (!cancelled) setProfiles((data ?? []) as ProfileRow[]);
    })();
    return () => {
      cancelled = true;
    };
    // `key` is the stable identity of `ids`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  const nameOf = useCallback(
    (id: string | null | undefined): string => {
      if (!id) return "—";
      const p = profiles.find((row) => row.user_id === id);
      return p?.full_name || p?.email || id.slice(0, 8);
    },
    [profiles],
  );

  return { nameOf, profiles };
}
