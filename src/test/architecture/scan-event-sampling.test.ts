/**
 * Architecture guard — `scan_events` may only be written by the
 * `log_scan_event` SECURITY DEFINER RPC. No client/server code may
 * `from("scan_events").insert(...)` directly. This protects the
 * per-device rate limit, sampling, and RLS pathway.
 */

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "fs";
import path from "path";

const SRC = path.resolve(__dirname, "../..");

// Allow this guard itself.
const ALLOW = new Set<string>([
  path.join(SRC, "test/architecture/scan-event-sampling.test.ts"),
]);

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

describe("scan_events writes only via log_scan_event RPC", () => {
  it("no source file performs a direct insert on scan_events", () => {
    const offenders: string[] = [];
    const files = walk(SRC).filter((f) => !ALLOW.has(f));
    const re = /from\(\s*["']scan_events["']\s*\)/;
    for (const f of files) {
      const src = readFileSync(f, "utf8");
      if (re.test(src)) offenders.push(path.relative(process.cwd(), f));
    }
    expect(
      offenders,
      `These files bypass log_scan_event RPC by writing scan_events directly:\n${offenders.join("\n")}`,
    ).toEqual([]);
  });
});