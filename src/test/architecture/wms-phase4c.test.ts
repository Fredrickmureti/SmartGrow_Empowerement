/**
 * Architecture guard — WMS Phase 4c (Cycle counting).
 *
 * Warehouse Management must never edit inventory quantities directly.
 * Every cycle-count adjustment flows through the sanctioned inventory
 * RPC (`apply_or_request_stock_adjustment`), which is invoked from
 * `post_count_session`. The client only calls the three RPCs below.
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

describe("wms phase 4c architecture", () => {
  const files = walk(SRC).filter((f) => f !== SELF && !/\btest\b/.test(f));
  const warehousePages = files.filter((f) => f.includes(`${path.sep}pages${path.sep}warehouse${path.sep}`));

  it("no warehouse page updates stock_quants directly", () => {
    const offenders: string[] = [];
    for (const f of warehousePages) {
      const src = readFileSync(f, "utf8");
      if (
        /from\(\s*["']stock_quants["']\s*\)/.test(src) &&
        /\.(update|insert|delete|upsert)\s*\(/.test(src)
      ) {
        offenders.push(path.relative(SRC, f));
      }
    }
    expect(
      offenders,
      `Warehouse pages must go through the inventory adjustment RPC — never write stock_quants directly:\n${offenders.join("\n")}`,
    ).toEqual([]);
  });

  it("no client code inserts count sessions or lines directly", () => {
    const offenders: string[] = [];
    for (const f of files) {
      const src = readFileSync(f, "utf8");
      if (
        (/from\(\s*["']wms_count_sessions["']\s*\)/.test(src) ||
          /from\(\s*["']wms_count_lines["']\s*\)/.test(src)) &&
        /\.(insert|upsert)\s*\(/.test(src)
      ) {
        offenders.push(path.relative(SRC, f));
      }
    }
    expect(
      offenders,
      `Seed count sessions/lines via create_count_session — never .insert:\n${offenders.join("\n")}`,
    ).toEqual([]);
  });

  it("no client code updates counted_qty / variance_qty / posted_at directly", () => {
    const offenders: string[] = [];
    for (const f of files) {
      const src = readFileSync(f, "utf8");
      if (
        (/from\(\s*["']wms_count_lines["']\s*\)/.test(src) &&
          /\.update\s*\(\s*\{[^}]*(counted_qty|variance_qty)\s*:/s.test(src)) ||
        (/from\(\s*["']wms_count_sessions["']\s*\)/.test(src) &&
          /\.update\s*\(\s*\{[^}]*(state|posted_at)\s*:/s.test(src))
      ) {
        offenders.push(path.relative(SRC, f));
      }
    }
    expect(
      offenders,
      `Mutate count lines/sessions via record_count / post_count_session — never direct .update:\n${offenders.join("\n")}`,
    ).toEqual([]);
  });

  it("cycle-count screens call the sanctioned RPCs", () => {
    const planner = readFileSync(path.join(SRC, "pages/warehouse/CycleCountPlanner.tsx"), "utf8");
    const sessionSrc = readFileSync(path.join(SRC, "pages/warehouse/CountSession.tsx"), "utf8");
    const review = readFileSync(path.join(SRC, "pages/warehouse/CountReview.tsx"), "utf8");
    expect(/rpc\(\s*["']create_count_session["']/.test(planner)).toBe(true);
    expect(/rpc\(\s*["']record_count["']/.test(sessionSrc)).toBe(true);
    expect(/rpc\(\s*["']post_count_session["']/.test(review)).toBe(true);
  });
});
