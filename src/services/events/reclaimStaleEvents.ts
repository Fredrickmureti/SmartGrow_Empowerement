/**
 * reclaimStaleBusinessEvents — re-queue outbox rows whose lease expired
 * because the host draining them died mid-handler.
 *
 * Lives with the saga (the outbox owner), not with printing: it recovers
 * *business events*, not print jobs. Print-job recovery is
 * `services/printing/recovery`.
 */
import { supabase } from '@/integrations/supabase/client';

export async function reclaimStaleBusinessEvents(): Promise<number> {
  try {
    const { data } = await supabase.rpc('reclaim_stale_business_events');
    return Array.isArray(data) ? data.length : 0;
  } catch {
    return 0;
  }
}
