/**
 * assignmentsRealtime — singleton Postgres-changes channel per org.
 *
 * Audit Wave 9d.9 (P4 #22). Previously, every consumer of
 * `useDeviceAssignments` (HardwareDevices, useHardwareRegistryCrud,
 * useHardwareProxy, useDeviceForRole-via-…) opened its own
 * `supabase.channel('device_assignments:<org>:<uuid>')`. On a busy
 * Platform / POS view that meant 5–8 parallel WebSocket subscriptions
 * to the same table, each delivering identical events. Realtime
 * connections are quota-limited per project and the duplicate traffic
 * shows up as visible jank when many devices update at once.
 *
 * This module exposes a single subscription per `organization_id`,
 * reference-counted so the channel goes away once the last subscriber
 * unmounts. Each subscriber is a plain callback — the hook layer
 * translates those into `queryClient.invalidateQueries(...)` calls.
 */
import { supabase } from '@/integrations/supabase/client';

type Listener = () => void;

interface Entry {
  channel: ReturnType<typeof supabase.channel>;
  listeners: Set<Listener>;
}

const channels = new Map<string, Entry>();

/**
 * Subscribe to device_assignments changes for `orgId`. Returns an
 * unsubscribe function. The underlying realtime channel is created on
 * the first call and torn down when the last listener unsubscribes.
 */
export function subscribeAssignments(orgId: string, listener: Listener): () => void {
  let entry = channels.get(orgId);
  if (!entry) {
    const channel = supabase
      .channel(`device_assignments:${orgId}`)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'device_assignments',
          filter: `organization_id=eq.${orgId}`,
        },
        () => {
          const e = channels.get(orgId);
          if (!e) return;
          for (const l of e.listeners) {
            try { l(); } catch { /* listener should not throw */ }
          }
        },
      )
      .subscribe();
    entry = { channel, listeners: new Set() };
    channels.set(orgId, entry);
  }
  entry.listeners.add(listener);

  return () => {
    const e = channels.get(orgId);
    if (!e) return;
    e.listeners.delete(listener);
    if (e.listeners.size === 0) {
      void supabase.removeChannel(e.channel);
      channels.delete(orgId);
    }
  };
}

/** Test-only: clear every active channel. */
export function _resetAssignmentsRealtime(): void {
  for (const [, e] of channels) {
    void supabase.removeChannel(e.channel);
  }
  channels.clear();
}
