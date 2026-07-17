/**
 * Architecture guard — WMS Phase 13 (RF / mobile operator shell).
 *
 * Enforces:
 *  1. All Supabase RPCs from the mobile app go through the offline queue
 *     (`enqueue()`) — never directly via `supabase.rpc(...)`. This gives us
 *     a single retry/idempotency chokepoint.
 *  2. Mobile pages live under `src/pages/warehouse-mobile/` and use
 *     `MobileWarehouseLayout` (guarantees the queue indicator is rendered
 *     and the drain loop is started).
 *  3. The /wm route tree is mounted in App.tsx.
 *  4. Every scan-driven flow (putaway, pick, count, receive) is wired to a
 *     route.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync, existsSync } from "fs";
import path from "path";

const SRC = path.resolve(__dirname, "../..");
const MOBILE = path.join(SRC, "apps/warehouse-mobile");
const PAGES = path.join(SRC, "pages/warehouse-mobile");

function walk(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name.startsWith(".")) continue;
    const full = path.join(dir, name);
    const s = statSync(full);
    if (s.isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(name)) out.push(full);
  }
  return out;
}

describe("wms phase 13 — RF/mobile shell architecture", () => {
  it("mobile pages never call supabase.rpc directly (must use enqueue)", () => {
    const files = [...walk(PAGES), ...walk(MOBILE)].filter(
      (f) => !f.endsWith("offlineQueue.ts"),
    );
    const banned = /supabase\.rpc\s*\(/;
    const offenders = files.filter((f) => banned.test(readFileSync(f, "utf8")));
    expect(
      offenders.map((f) => path.relative(SRC, f)),
      "Mobile RPCs must flow through enqueue() in offlineQueue.ts",
    ).toEqual([]);
  });

  it("every mobile page uses MobileWarehouseLayout", () => {
    const pages = walk(PAGES);
    expect(pages.length, "expected mobile pages under pages/warehouse-mobile").toBeGreaterThan(0);
    const missing = pages.filter(
      (f) => !/MobileWarehouseLayout/.test(readFileSync(f, "utf8")),
    );
    expect(missing.map((f) => path.relative(SRC, f))).toEqual([]);
  });

  it("offline queue exposes enqueue, drainOnce, and startDrainLoop", () => {
    const src = readFileSync(path.join(MOBILE, "offlineQueue.ts"), "utf8");
    for (const sym of ["enqueue", "drainOnce", "startDrainLoop", "subscribe"]) {
      expect(src, `offlineQueue must export ${sym}`).toMatch(new RegExp(`export\\s+(async\\s+)?function\\s+${sym}\\b`));
    }
  });

  it("/wm route tree is mounted in App.tsx", () => {
    const app = readFileSync(path.join(SRC, "App.tsx"), "utf8");
    expect(app).toMatch(/WarehouseMobileApp/);
    expect(app).toMatch(/path=["']\/wm\/\*["']/);
  });

  it("scan-driven flows (putaway/pick/count/receive) are all wired", () => {
    const routes = readFileSync(path.join(MOBILE, "routes.tsx"), "utf8");
    for (const p of ["putaway/:id", "pick/:id", "count/:id", "receive/:id"]) {
      expect(routes, `route missing: ${p}`).toContain(p);
    }
  });

  it("mobile layout starts the drain loop and renders the queue indicator", () => {
    const layout = readFileSync(path.join(MOBILE, "MobileWarehouseLayout.tsx"), "utf8");
    expect(layout).toMatch(/startDrainLoop\s*\(/);
    expect(layout).toMatch(/QueueIndicator/);
  });
});
