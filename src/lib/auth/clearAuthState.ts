/**
 * clearAuthState — nuke every Supabase auth artifact in the browser.
 *
 * Used when the user wants to "use a different email" after a corrupted
 * signup. Without this the browser keeps the broken session in
 * localStorage / IndexedDB and the user has to open incognito to recover.
 *
 * Steps:
 *   1. Sign the current session out locally (do not call the server — the
 *      account may have already been reaped).
 *   2. Remove every storage key prefixed with `sb-` (Supabase) and our own
 *      onboarding scratchpad keys.
 *   3. Best-effort wipe the Supabase IndexedDB store used by the JS client
 *      to persist refresh tokens.
 */
import { supabase } from "@/integrations/supabase/client";

const STORAGE_KEY_PREFIXES = ["sb-", "supabase.", "onboarding_"] as const;

function purgeWebStorage(storage: Storage | null) {
  if (!storage) return;
  const toRemove: string[] = [];
  for (let i = 0; i < storage.length; i++) {
    const key = storage.key(i);
    if (!key) continue;
    if (STORAGE_KEY_PREFIXES.some((p) => key.startsWith(p))) {
      toRemove.push(key);
    }
  }
  for (const key of toRemove) {
    try {
      storage.removeItem(key);
    } catch {
      /* swallow — best effort */
    }
  }
}

async function purgeIndexedDB() {
  if (typeof indexedDB === "undefined" || !indexedDB.databases) return;
  try {
    const dbs = await indexedDB.databases();
    await Promise.all(
      dbs
        .filter((db) => !!db.name && (db.name.startsWith("sb-") || db.name.includes("supabase")))
        .map(
          (db) =>
            new Promise<void>((resolve) => {
              const req = indexedDB.deleteDatabase(db.name!);
              req.onsuccess = () => resolve();
              req.onerror = () => resolve();
              req.onblocked = () => resolve();
            }),
        ),
    );
  } catch {
    /* swallow — best effort */
  }
}

/**
 * Wipe local auth state. Returns when the local cleanup finishes.
 * Does NOT redirect — caller decides where to go next.
 */
export async function clearLocalAuthState(): Promise<void> {
  try {
    await supabase.auth.signOut({ scope: "local" });
  } catch {
    /* swallow — we're nuking anyway */
  }

  if (typeof window !== "undefined") {
    purgeWebStorage(window.localStorage ?? null);
    purgeWebStorage(window.sessionStorage ?? null);
  }

  await purgeIndexedDB();
}
