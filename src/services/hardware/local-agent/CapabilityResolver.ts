/**
 * CapabilityResolver — Phase 3 client-side capability lookup.
 *
 * Turns capability-shaped intents ("give me any 80mm ESC/POS receipt
 * printer with a cutter on workstation W") into a concrete device row
 * from `public.workstation_devices`. Used by higher-level services that
 * want to dispatch via `AgentClient.enqueueRelayJob` without hard-coding
 * IP addresses or vendor/product IDs.
 *
 * Kept intentionally thin: no caching, no realtime subscription — a
 * consuming hook can add those on top. The single source of truth is
 * the database view populated by the agent's manifest publisher.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export interface WorkstationDevice {
  id: string;
  organization_id: string;
  workstation_id: string;
  device_key: string;
  role: string;
  transport: string;
  driver: string | null;
  name: string | null;
  capabilities: Record<string, unknown>;
  health: string;
  last_seen_at: string | null;
  metadata: Record<string, unknown>;
}

export interface ResolveNeeds {
  workstationId: string;
  role: string;
  /** Every listed key/value must match on the device's capabilities. */
  needs?: Record<string, unknown>;
  /** Only consider devices in one of these health states. Default: ['ok', 'degraded']. */
  healthIn?: string[];
}

export class CapabilityResolver {
  constructor(private readonly supabase: SupabaseClient) {}

  /**
   * Return every device on a workstation matching a role (regardless of
   * health). Useful for the ERP admin surface / device list UI.
   */
  async listForWorkstation(workstationId: string): Promise<WorkstationDevice[]> {
    const { data, error } = await this.supabase
      .from('workstation_devices')
      .select('*')
      .eq('workstation_id', workstationId)
      .order('role');
    if (error) throw error;
    return (data ?? []) as WorkstationDevice[];
  }

  /**
   * Best-match a single device for a capability need. Ranks:
   *   1. exact capability match count (desc),
   *   2. health (ok > degraded),
   *   3. most-recently-seen.
   * Returns null if nothing matches — the caller decides whether to fall
   * back to a legacy endpoint-shaped call.
   */
  async resolve(req: ResolveNeeds): Promise<WorkstationDevice | null> {
    const health = req.healthIn ?? ['ok', 'degraded'];
    const { data, error } = await this.supabase
      .from('workstation_devices')
      .select('*')
      .eq('workstation_id', req.workstationId)
      .eq('role', req.role)
      .in('health', health);
    if (error) throw error;
    const rows = (data ?? []) as WorkstationDevice[];
    if (rows.length === 0) return null;

    const needs = req.needs ?? {};
    const scored = rows.map((row) => {
      let score = 0;
      for (const [k, v] of Object.entries(needs)) {
        if ((row.capabilities as Record<string, unknown>)[k] === v) score += 1;
        else score -= 1; // mismatch is worse than missing
      }
      if (row.health === 'ok') score += 0.5;
      const seen = row.last_seen_at ? Date.parse(row.last_seen_at) : 0;
      return { row, score, seen };
    });
    scored.sort((a, b) => (b.score - a.score) || (b.seen - a.seen));
    // Require at least a non-negative score so obvious mismatches don't win.
    const winner = scored[0];
    return winner && winner.score >= 0 ? winner.row : null;
  }
}
