/**
 * CapabilityResolver — Phase 2b (unified device_assignments registry).
 *
 * Turns capability-shaped intents ("give me any 80mm ESC/POS receipt
 * printer with a cutter on workstation W") into a concrete
 * `device_assignments` row scoped to that workstation. Reads the row
 * type inline so the agent path stays independent of React types.
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
  /** Only consider devices in one of these health states. Default: ['ok','unknown']. */
  healthIn?: string[];
}

type Row = {
  id: string;
  organization_id: string;
  workstation_id: string;
  device_key: string | null;
  role: string;
  transport: string;
  driver: string | null;
  display_name: string;
  capabilities: Record<string, unknown> | null;
  status: string;
  last_seen_at: string | null;
  config: Record<string, unknown> | null;
};

function mapRow(r: Row): WorkstationDevice {
  return {
    id: r.id,
    organization_id: r.organization_id,
    workstation_id: r.workstation_id,
    device_key: r.device_key ?? '',
    role: r.role,
    transport: r.transport,
    driver: r.driver,
    name: r.display_name,
    capabilities: r.capabilities ?? {},
    health: r.status,
    last_seen_at: r.last_seen_at,
    metadata: r.config ?? {},
  };
}

const COLS =
  'id, organization_id, workstation_id, device_key, role, transport, driver, display_name, capabilities, status, last_seen_at, config';

export class CapabilityResolver {
  constructor(private readonly supabase: SupabaseClient) {}

  async listForWorkstation(workstationId: string): Promise<WorkstationDevice[]> {
    const { data, error } = await this.supabase
      .from('device_assignments')
      .select(COLS)
      .eq('workstation_id', workstationId)
      .eq('enabled', true)
      .order('role');
    if (error) throw error;
    return ((data ?? []) as unknown as Row[]).map(mapRow);
  }

  async resolve(req: ResolveNeeds): Promise<WorkstationDevice | null> {
    // "ok" and "degraded" are legacy health values; the unified registry
    // uses `status` which may hold either that vocabulary OR "unknown".
    const health = req.healthIn ?? ['ok', 'degraded', 'unknown'];
    const { data, error } = await this.supabase
      .from('device_assignments')
      .select(COLS)
      .eq('workstation_id', req.workstationId)
      .eq('role', req.role)
      .eq('enabled', true)
      .in('status', health);
    if (error) throw error;
    const rows = ((data ?? []) as unknown as Row[]).map(mapRow);
    if (rows.length === 0) return null;

    const needs = req.needs ?? {};
    const scored = rows.map((row) => {
      let score = 0;
      for (const [k, v] of Object.entries(needs)) {
        if ((row.capabilities as Record<string, unknown>)[k] === v) score += 1;
        else score -= 1;
      }
      if (row.health === 'ok') score += 0.5;
      const seen = row.last_seen_at ? Date.parse(row.last_seen_at) : 0;
      return { row, score, seen };
    });
    scored.sort((a, b) => (b.score - a.score) || (b.seen - a.seen));
    const winner = scored[0];
    return winner && winner.score >= 0 ? winner.row : null;
  }
}
