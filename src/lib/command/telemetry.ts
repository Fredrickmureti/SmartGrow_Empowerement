/**
 * Command Palette — Telemetry
 *
 * Lightweight, fire-and-forget logging of user interactions with the
 * command palette. We capture two signals:
 *
 *   1. SELECT — user picked an entry. Useful to learn which commands
 *      get used vs which are dead weight.
 *   2. ZERO_RESULT — query returned no matches. Useful to discover
 *      missing keywords / aliases.
 *
 * All inserts happen on a debounced "best effort" basis. Failure is
 * swallowed — telemetry never blocks navigation. RLS on
 * `command_telemetry` lets users INSERT their own org's rows but only
 * admins can SELECT (configured in the migration).
 */

import { supabase } from "@/integrations/supabase/client";

export type TelemetryEventType = "select" | "zero_result";

interface TelemetryPayload {
  eventType: TelemetryEventType;
  query: string;
  resultCount: number;
  selectedId?: string | null;
  selectedKind?: string | null;
  currentAppId?: string | null;
  organizationId?: string | null;
}

/** Per-tab queue + flush; avoids one insert per keystroke. */
let queue: TelemetryPayload[] = [];
let flushTimer: ReturnType<typeof setTimeout> | null = null;

async function flush() {
  flushTimer = null;
  if (queue.length === 0) return;
  const batch = queue.splice(0, queue.length);
  const rows = batch
    .filter((p) => p.organizationId)
    .map((p) => ({
      event_type: p.eventType,
      query: p.query.slice(0, 200),
      result_count: p.resultCount,
      selected_id: p.selectedId ?? null,
      selected_kind: p.selectedKind ?? null,
      current_app_id: p.currentAppId ?? null,
      organization_id: p.organizationId,
    }));
  if (rows.length === 0) return;
  try {
    // The `command_telemetry` table is provisioned by a separate
    // migration (see plan, Stage 6). We cast through `unknown` so the
    // generated Database type doesn't block compilation in environments
    // that haven't applied the migration yet — and the insert silently
    // no-ops via the catch if the table is absent at runtime.
    await (
      supabase.from as unknown as (t: string) => {
        insert: (rows: unknown) => Promise<{ error: unknown }>;
      }
    )("command_telemetry").insert(rows);
  } catch {
    /* silently ignore — telemetry is non-critical */
  }
}

export function logCommandEvent(payload: TelemetryPayload) {
  // Skip telemetry for trivial queries (single char) and empty events.
  if (payload.query.length < 2 && payload.eventType === "zero_result") return;
  queue.push(payload);
  if (queue.length >= 10) {
    if (flushTimer) clearTimeout(flushTimer);
    void flush();
    return;
  }
  if (!flushTimer) {
    flushTimer = setTimeout(() => void flush(), 4000);
  }
}

/** Force-flush — call on page unload to avoid losing pending events. */
export function flushTelemetry() {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  void flush();
}

if (typeof window !== "undefined") {
  // `visibilitychange` + `pagehide` are reliable across browsers
  // (especially iOS Safari, where `beforeunload` does not fire on
  // navigation away from the tab). We flush only when the page is
  // actually being hidden / unloaded, not on tab focus changes that
  // keep the document visible.
  const onHide = () => {
    if (document.visibilityState === "hidden") flushTelemetry();
  };
  document.addEventListener("visibilitychange", onHide);
  window.addEventListener("pagehide", flushTelemetry);
}
