/**
 * H6 architecture guard — `pos_drawer_events` is RPC-only from the client.
 * All inserts must go through `process_pos_drawer_event` so the row shape,
 * branch stamping, and triggered_by are canonicalized server-side.
 */
import { describe, it, expect } from "vitest";
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";

const ALLOWLIST = [
  /^src\/integrations\/supabase\/types\.ts$/,
  /^src\/test\/architecture\/no-client-pos-drawer-event-writes\.test\.ts$/,
];

describe("POS architecture guard — pos_drawer_events is RPC-only from the client", () => {
  it("no client file performs .insert/.update/.upsert/.delete on pos_drawer_events", () => {
    const candidates = execSync(
      'rg --files-with-matches "pos_drawer_events" src/ || true',
      { encoding: "utf8" },
    )
      .split("\n")
      .filter(Boolean)
      .filter((p) => !ALLOWLIST.some((re) => re.test(p)));

    const offenders: string[] = [];
    for (const p of candidates) {
      const src = readFileSync(p, "utf8");
      const stripped = src
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/(^|\s)\/\/[^\n]*/g, "$1");
      const re =
        /\bfrom\s*\(\s*["']pos_drawer_events["']\s*\)[\s\S]{0,400}?\.(insert|update|upsert|delete)\s*\(/;
      if (re.test(stripped)) offenders.push(p);
    }

    expect(
      offenders,
      `Client files mutating pos_drawer_events directly:\n${offenders.join("\n")}\n` +
        "Use the process_pos_drawer_event RPC instead.",
    ).toEqual([]);
  });
});