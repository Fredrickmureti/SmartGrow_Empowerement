/**
 * Stage 6.1 architecture guard — `pos_cash_movements` is RPC-only from the
 * client. All movement inserts/updates/deletes must go through the
 * `process_pos_cash_movement` SECURITY DEFINER RPC, which validates shift,
 * register, role, override scope, and posts the matching journal entry.
 *
 * Allowed exceptions:
 *   - generated Supabase types
 *   - this guard file itself
 *   - the dev-only POS data reset tool (calls a server-side reset RPC)
 */
import { describe, it, expect } from "vitest";
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";

const ALLOWLIST = [
  /^src\/integrations\/supabase\/types\.ts$/,
  /^src\/test\/architecture\/no-client-pos-cash-writes\.test\.ts$/,
  /^src\/components\/pos\/POSDataResetTool\.tsx$/,
];

describe("POS architecture guard — pos_cash_movements is RPC-only from the client", () => {
  it("no client file performs .insert/.update/.upsert/.delete on pos_cash_movements", () => {
    const candidates = execSync(
      'rg --files-with-matches "pos_cash_movements" src/ || true',
      { encoding: "utf8" }
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
        /\bfrom\s*\(\s*["']pos_cash_movements["']\s*\)[\s\S]{0,400}?\.(insert|update|upsert|delete)\s*\(/;
      if (re.test(stripped)) offenders.push(p);
    }

    expect(
      offenders,
      `Client files mutating pos_cash_movements directly:\n${offenders.join("\n")}\n` +
        "Use the process_pos_cash_movement RPC instead.",
    ).toEqual([]);
  });
});
