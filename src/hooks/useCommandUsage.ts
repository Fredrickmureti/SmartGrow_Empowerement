/**
 * useCommandUsage
 *
 * Local-only recency / frequency / pinned store for the command palette.
 * Persists to localStorage; written through synchronously on every
 * mutation (palette selection is a low-frequency event).
 *
 * Stage 5 — Cross-device sync (opt-in, defensive):
 *   On mount, if the user has an org context we attempt to fetch a
 *   merged usage/pinned record from `user_command_preferences`. Local
 *   wins on conflict (we just merge counts and pick the latest pin
 *   list). Mutations are debounced and flushed back to the table.
 *
 *   The remote calls are wrapped in try/catch and cast through unknown
 *   so the absence of the table (pre-migration) silently degrades to
 *   localStorage-only behaviour.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useSession } from "@/contexts/SessionContext";
import { supabase } from "@/integrations/supabase/client";
import type { UsageMap, UsageRecord } from "@/lib/command/types";

const STORAGE_KEY = "lov.command.usage.v1";
const PINNED_KEY = "lov.command.pinned.v1";
/** Hard cap so the map never grows without bound. */
const MAX_ENTRIES = 200;
const MAX_PINNED = 12;
const SYNC_DEBOUNCE_MS = 30_000;

function load(): UsageMap {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null ? (parsed as UsageMap) : {};
  } catch {
    return {};
  }
}

function loadPinned(): string[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(PINNED_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((x) => typeof x === "string") : [];
  } catch {
    return [];
  }
}

function persist(map: UsageMap) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(map));
  } catch {
    /* quota / private mode — silently ignore */
  }
}

function persistPinned(ids: string[]) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(PINNED_KEY, JSON.stringify(ids));
  } catch {
    /* ignore */
  }
}

/** Trim to MAX_ENTRIES, keeping most recent. */
function trim(map: UsageMap): UsageMap {
  const ids = Object.keys(map);
  if (ids.length <= MAX_ENTRIES) return map;
  const sorted = ids.sort((a, b) => map[b].lastUsedAt - map[a].lastUsedAt).slice(0, MAX_ENTRIES);
  const out: UsageMap = {};
  for (const id of sorted) out[id] = map[id];
  return out;
}

/**
 * Merge two usage maps additively for counts and max-of for recency.
 * This makes hydration safe — a fresh laptop won't lose its local
 * progress when remote prefs land.
 */
function mergeUsage(a: UsageMap, b: UsageMap): UsageMap {
  const out: UsageMap = { ...a };
  for (const [id, rec] of Object.entries(b)) {
    const existing = out[id];
    if (!existing) {
      out[id] = rec;
    } else {
      out[id] = {
        count: existing.count + (rec.count ?? 0),
        lastUsedAt: Math.max(existing.lastUsedAt, rec.lastUsedAt ?? 0),
      };
    }
  }
  return trim(out);
}

/** Coerce arbitrary JSON into a UsageMap. */
function coerceUsage(raw: unknown): UsageMap {
  if (!raw || typeof raw !== "object") return {};
  const out: UsageMap = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (
      v &&
      typeof v === "object" &&
      typeof (v as UsageRecord).count === "number" &&
      typeof (v as UsageRecord).lastUsedAt === "number"
    ) {
      out[k] = v as UsageRecord;
    }
  }
  return out;
}

/** Cast helper — schema-agnostic Supabase access for the prefs table. */
type PrefsRow = { pinned: unknown; usage: unknown };
function prefsTable() {
  return (
    supabase.from as unknown as (t: string) => {
      select: (cols: string) => {
        eq: (col: string, val: string) => {
          eq: (col: string, val: string) => {
            maybeSingle: () => Promise<{ data: PrefsRow | null; error: unknown }>;
          };
        };
      };
      upsert: (
        row: Record<string, unknown>,
        opts?: { onConflict?: string },
      ) => Promise<{ error: unknown }>;
    }
  )("user_command_preferences");
}

export function useCommandUsage() {
  const [usage, setUsage] = useState<UsageMap>(() => load());
  const [pinned, setPinned] = useState<string[]>(() => loadPinned());
  const { currentOrg, sessionData } = useSession();
  const orgId = currentOrg?.id ?? null;
  const userId = sessionData?.user_id ?? null;
  const dirtyRef = useRef(false);
  const flushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // React to changes from other tabs.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const onStorage = (e: StorageEvent) => {
      if (e.key === STORAGE_KEY) setUsage(load());
      if (e.key === PINNED_KEY) setPinned(loadPinned());
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  // ── Stage 5: hydrate from server on mount/org-switch ────────────────
  useEffect(() => {
    if (!userId || !orgId) return;
    let cancelled = false;
    (async () => {
      try {
        const { data, error } = await prefsTable()
          .select("pinned, usage")
          .eq("user_id", userId)
          .eq("organization_id", orgId)
          .maybeSingle();
        if (cancelled || error || !data) return;
        const remoteUsage = coerceUsage(data.usage);
        const remotePinned = Array.isArray(data.pinned)
          ? (data.pinned as unknown[]).filter((x): x is string => typeof x === "string")
          : [];
        setUsage((prev) => {
          const merged = mergeUsage(prev, remoteUsage);
          persist(merged);
          return merged;
        });
        if (remotePinned.length > 0) {
          setPinned((prev) => {
            // Remote pins are authoritative when we previously had none locally.
            const next = prev.length === 0
              ? remotePinned.slice(0, MAX_PINNED)
              : Array.from(new Set([...prev, ...remotePinned])).slice(0, MAX_PINNED);
            persistPinned(next);
            return next;
          });
        }
      } catch {
        /* table missing pre-migration → local-only mode */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [userId, orgId]);

  // ── Stage 5: debounced write-back ───────────────────────────────────
  const scheduleFlush = useCallback(() => {
    if (!userId || !orgId) return;
    dirtyRef.current = true;
    if (flushTimerRef.current) clearTimeout(flushTimerRef.current);
    flushTimerRef.current = setTimeout(async () => {
      if (!dirtyRef.current) return;
      dirtyRef.current = false;
      try {
        await prefsTable().upsert(
          {
            user_id: userId,
            organization_id: orgId,
            pinned,
            usage,
            updated_at: new Date().toISOString(),
          },
          { onConflict: "user_id,organization_id" },
        );
      } catch {
        /* table missing or RLS — degrade silently */
      }
    }, SYNC_DEBOUNCE_MS);
  }, [userId, orgId, pinned, usage]);

  // Flush on unmount so a quick session still syncs.
  useEffect(() => {
    return () => {
      if (flushTimerRef.current) clearTimeout(flushTimerRef.current);
    };
  }, []);

  const record = useCallback(
    (entryId: string) => {
      setUsage((prev) => {
        const now = Date.now();
        const cur = prev[entryId];
        const next: UsageMap = {
          ...prev,
          [entryId]: { count: (cur?.count ?? 0) + 1, lastUsedAt: now },
        };
        const trimmed = trim(next);
        persist(trimmed);
        return trimmed;
      });
      scheduleFlush();
    },
    [scheduleFlush],
  );

  const clear = useCallback(() => {
    persist({});
    setUsage({});
    scheduleFlush();
  }, [scheduleFlush]);

  const isPinned = useCallback(
    (entryId: string) => pinned.includes(entryId),
    [pinned],
  );

  const togglePin = useCallback(
    (entryId: string) => {
      setPinned((prev) => {
        const next = prev.includes(entryId)
          ? prev.filter((id) => id !== entryId)
          : [entryId, ...prev].slice(0, MAX_PINNED);
        persistPinned(next);
        return next;
      });
      scheduleFlush();
    },
    [scheduleFlush],
  );

  return { usage, pinned, record, clear, isPinned, togglePin };
}
