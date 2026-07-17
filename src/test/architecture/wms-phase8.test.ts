/**
 * Architecture guard — WMS Phase 8 (Replenishment & slotting).
 *
 * - `wms_replenishment_rules` writes are RLS-scoped inserts/updates from the
 *   Replenishment page only. Task creation MUST come from the
 *   `generate_replenishment_tasks` RPC — no client code may insert directly
 *   into `wms_tasks` with `task_type = 'replenish'`.
 * - Slotting is a read-only view (`wms_slotting_velocity_view`). No client
 *   code may write to it (it's a view — this is defence in depth).
 * - The Replenishment page calls the sanctioned RPC.
 * - Nav wires both pages under Operations.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "fs";
import path from "path";

const SRC = path.resolve(__dirname, "../..");
const SELF = __filename;

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name.startsWith(".")) continue;
    const full = path.join(dir, name);
    const s = statSync(full);
    if (s.isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(name)) out.push(full);
  }
  return out;
}

describe("wms phase 8 architecture", () => {
  const files = walk(SRC).filter((f) => f !== SELF && !/\btest\b/.test(f));

  it("no client code writes to wms_slotting_velocity_view (it's a view)", () => {
    const offenders: string[] = [];
    const banned = /from\(\s*["']wms_slotting_velocity_view["']\s*\)\s*\.(insert|update|upsert|delete)\s*\(/;
    for (const f of files) {
      const src = readFileSync(f, "utf8");
      if (banned.test(src)) offenders.push(path.relative(SRC, f));
    }
    expect(offenders).toEqual([]);
  });

  it("no client code inserts a replenish task directly (must go through generate_replenishment_tasks)", () => {
    const offenders: string[] = [];
    for (const f of files) {
      const src = readFileSync(f, "utf8");
      // Look for wms_tasks insert with a replenish task_type in near proximity.
      const inserts = /from\(\s*["']wms_tasks["']\s*\)\s*\.(insert|upsert)\s*\(([\s\S]{0,400})\)/g;
      let m: RegExpExecArray | null;
      while ((m = inserts.exec(src))) {
        if (/task_type\s*:\s*["']replenish["']/.test(m[2])) {
          offenders.push(path.relative(SRC, f));
          break;
        }
      }
    }
    expect(offenders, `Use rpc('generate_replenishment_tasks') instead:\n${offenders.join("\n")}`).toEqual([]);
  });

  it("Replenishment page calls generate_replenishment_tasks RPC", () => {
    const src = readFileSync(path.join(SRC, "pages/warehouse/Replenishment.tsx"), "utf8");
    expect(/rpc\(\s*["']generate_replenishment_tasks["']/.test(src)).toBe(true);
  });

  it("nav wires Replenishment and Slotting", () => {
    const nav = readFileSync(path.join(SRC, "apps/warehouse/nav.ts"), "utf8");
    expect(nav.includes("/warehouse-app/replenishment")).toBe(true);
    expect(nav.includes("/warehouse-app/slotting")).toBe(true);
  });

  it("routes register /replenishment and /slotting", () => {
    const routes = readFileSync(path.join(SRC, "apps/warehouse/routes.tsx"), "utf8");
    expect(/path="replenishment"/.test(routes)).toBe(true);
    expect(/path="slotting"/.test(routes)).toBe(true);
  });
});
