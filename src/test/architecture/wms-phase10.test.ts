/**
 * Architecture guard — WMS Phase 10 (Labour management).
 *
 * - `wms_tasks.earned_seconds` and `.actual_seconds` are trigger-managed.
 *   No client code may set them directly.
 * - `wms_task_standards` writes are allowed only from the LabourBoard page.
 * - `wms_operator_productivity_view` is read-only.
 * - LabourBoard queries the view.
 * - Route + nav are wired.
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

describe("wms phase 10 architecture", () => {
  const files = walk(SRC).filter((f) => f !== SELF && !/\btest\b/.test(f));

  it("no client code writes earned_seconds or actual_seconds", () => {
    const offenders: string[] = [];
    const banned = /\b(earned_seconds|actual_seconds)\s*:/;
    for (const f of files) {
      const src = readFileSync(f, "utf8");
      // only care about supabase write shapes; a mention in a type is fine
      if (/from\(\s*["']wms_tasks["']\s*\)/.test(src) && banned.test(src)) {
        offenders.push(path.relative(SRC, f));
      }
    }
    expect(
      offenders,
      `earned_seconds / actual_seconds are trigger-managed:\n${offenders.join("\n")}`
    ).toEqual([]);
  });

  it("wms_task_standards writes originate only from LabourBoard", () => {
    const offenders: string[] = [];
    const allowed = path.join(SRC, "pages/warehouse/LabourBoard.tsx");
    const write = /from\(\s*["']wms_task_standards["']\s*\)\s*\.(insert|update|upsert|delete)\s*\(/;
    for (const f of files) {
      if (f === allowed) continue;
      const src = readFileSync(f, "utf8");
      if (write.test(src)) offenders.push(path.relative(SRC, f));
    }
    expect(offenders).toEqual([]);
  });

  it("no client code writes to wms_operator_productivity_view", () => {
    const offenders: string[] = [];
    const banned = /from\(\s*["']wms_operator_productivity_view["']\s*\)\s*\.(insert|update|upsert|delete)\s*\(/;
    for (const f of files) {
      const src = readFileSync(f, "utf8");
      if (banned.test(src)) offenders.push(path.relative(SRC, f));
    }
    expect(offenders).toEqual([]);
  });

  it("LabourBoard reads the productivity view", () => {
    const src = readFileSync(path.join(SRC, "pages/warehouse/LabourBoard.tsx"), "utf8");
    expect(/from\(\s*["']wms_operator_productivity_view["']/.test(src)).toBe(true);
    expect(/from\(\s*["']wms_task_standards["']/.test(src)).toBe(true);
  });

  it("route and nav wire /labour", () => {
    const routes = readFileSync(path.join(SRC, "apps/warehouse/routes.tsx"), "utf8");
    const nav = readFileSync(path.join(SRC, "apps/warehouse/nav.ts"), "utf8");
    expect(/path="labour"/.test(routes)).toBe(true);
    expect(nav.includes("/warehouse-app/labour")).toBe(true);
  });
});
