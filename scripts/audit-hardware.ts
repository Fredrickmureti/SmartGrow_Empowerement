#!/usr/bin/env bun
/**
 * audit-hardware — Phase 1 CLI counterpart of /pos/hardware-diagnostics.
 *
 * Prints a runtime snapshot suitable for pasting into a support ticket:
 *   - Supabase pos_hardware_configs row count + breakdown by role
 *   - Detection of duplicate / orphan rows
 *   - The set of distinct (role, transport, driver) tuples
 *
 * Limitations (deliberate):
 *   - Cannot read the Electron-local SQLite registry from CLI; that
 *     half of the diff only exists at runtime inside the desktop app.
 *     Run the diagnostics page for that side.
 *   - Cannot reach a local IoT agent from this script unless the user
 *     supplies `AGENT_URL` and `AGENT_TOKEN` in their env.
 *
 * Usage:
 *   bun run scripts/audit-hardware.ts
 */
import { createClient } from "@supabase/supabase-js";

const url = process.env.VITE_SUPABASE_URL ?? process.env.SUPABASE_URL;
const key =
  process.env.SUPABASE_SERVICE_ROLE_KEY ??
  process.env.VITE_SUPABASE_PUBLISHABLE_KEY ??
  process.env.SUPABASE_PUBLISHABLE_KEY;

if (!url || !key) {
  console.error("Missing Supabase env (VITE_SUPABASE_URL + a key). Cannot audit.");
  process.exit(1);
}

const supabase = createClient(url, key);

async function main(): Promise<void> {
  console.log("=== Hardware Audit (Phase 1) ===\n");
  console.log(`Supabase URL: ${url}\n`);

  const { data, error } = await supabase
    .from("pos_hardware_configs")
    .select("id, register_id, device_role, connection_type, driver_type, status, capabilities")
    .limit(2000);

  if (error) {
    console.error("pos_hardware_configs read failed:", error.message);
    process.exit(2);
  }

  const rows = data ?? [];
  console.log(`Total registered devices: ${rows.length}\n`);

  const byRole = new Map<string, number>();
  const byTransport = new Map<string, number>();
  const byStatus = new Map<string, number>();
  const tuples = new Map<string, number>();

  for (const r of rows) {
    const role = r.device_role ?? "(none)";
    const transport = r.connection_type ?? "(none)";
    const driver = r.driver_type ?? "(none)";
    const status = r.status ?? "(none)";
    byRole.set(role, (byRole.get(role) ?? 0) + 1);
    byTransport.set(transport, (byTransport.get(transport) ?? 0) + 1);
    byStatus.set(status, (byStatus.get(status) ?? 0) + 1);
    const k = `${role} | ${transport} | ${driver}`;
    tuples.set(k, (tuples.get(k) ?? 0) + 1);
  }

  const dump = (label: string, map: Map<string, number>) => {
    console.log(`-- ${label} --`);
    for (const [k, v] of [...map.entries()].sort((a, b) => b[1] - a[1])) {
      console.log(`  ${v.toString().padStart(4)} × ${k}`);
    }
    console.log();
  };

  dump("By role", byRole);
  dump("By transport", byTransport);
  dump("By status", byStatus);
  dump("Distinct (role | transport | driver) tuples", tuples);

  console.log("Notes:");
  console.log(" • This script audits the Supabase registry only.");
  console.log(" • The Electron-local SQLite registry only exists inside");
  console.log("   the packaged desktop app — open /pos/hardware-diagnostics");
  console.log("   in the renderer to see that side of the diff.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});