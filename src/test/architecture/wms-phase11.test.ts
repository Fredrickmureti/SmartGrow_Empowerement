/**
 * Architecture guard — WMS Phase 11 (3PL activity-based billing).
 *
 * - `wms_billable_activities` is RPC-only from the client; no direct
 *   insert/update/delete against it.
 * - `wms_billing_tariffs` writes are allowed only from BillingBoard.
 * - BillingBoard reads the summary view + calls both billing RPCs.
 * - Route + nav wire `/billing`.
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

describe("wms phase 11 architecture", () => {
  const files = walk(SRC).filter((f) => f !== SELF && !/\btest\b/.test(f));

  it("wms_billable_activities is RPC-only from the client", () => {
    const banned = /from\(\s*["']wms_billable_activities["']\s*\)\s*\.(insert|update|upsert|delete)\s*\(/;
    const offenders: string[] = [];
    for (const f of files) {
      const src = readFileSync(f, "utf8");
      if (banned.test(src)) offenders.push(path.relative(SRC, f));
    }
    expect(offenders, `wms_billable_activities is RPC-only:\n${offenders.join("\n")}`).toEqual([]);
  });

  it("wms_billing_tariffs writes originate only from BillingBoard", () => {
    const allowed = path.join(SRC, "pages/warehouse/BillingBoard.tsx");
    const write = /from\(\s*["']wms_billing_tariffs["']\s*\)\s*\.(insert|update|upsert|delete)\s*\(/;
    const offenders: string[] = [];
    for (const f of files) {
      if (f === allowed) continue;
      const src = readFileSync(f, "utf8");
      if (write.test(src)) offenders.push(path.relative(SRC, f));
    }
    expect(offenders).toEqual([]);
  });

  it("summary view is read-only", () => {
    const banned = /from\(\s*["']wms_billable_activities_summary_view["']\s*\)\s*\.(insert|update|upsert|delete)\s*\(/;
    const offenders: string[] = [];
    for (const f of files) {
      const src = readFileSync(f, "utf8");
      if (banned.test(src)) offenders.push(path.relative(SRC, f));
    }
    expect(offenders).toEqual([]);
  });

  it("BillingBoard calls the required RPCs and reads the summary view", () => {
    const src = readFileSync(path.join(SRC, "pages/warehouse/BillingBoard.tsx"), "utf8");
    expect(src).toMatch(/rpc\(\s*["']capture_pending_billable_activities["']/);
    expect(src).toMatch(/rpc\(\s*["']generate_3pl_invoice["']/);
    expect(src).toMatch(/from\(\s*["']wms_billable_activities_summary_view["']/);
    expect(src).toMatch(/from\(\s*["']wms_billing_tariffs["']/);
  });

  it("route and nav wire /billing", () => {
    const routes = readFileSync(path.join(SRC, "apps/warehouse/routes.tsx"), "utf8");
    const nav = readFileSync(path.join(SRC, "apps/warehouse/nav.ts"), "utf8");
    expect(/path="billing"/.test(routes)).toBe(true);
    expect(nav.includes("/warehouse-app/billing")).toBe(true);
  });
});
