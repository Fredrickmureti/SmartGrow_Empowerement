/**
 * Stage I (H5) architecture guard — `pos_error_log` is RPC-only from the client.
 * All inserts must go through `log_pos_error` so business access, user stamping,
 * and severity normalization happen server-side. Mirrors the H6 drawer-events guard.
 */
import { describe, it, expect } from "vitest";
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";

const ALLOWLIST = [
  /^src\/integrations\/supabase\/types\.ts$/,
  /^src\/test\/architecture\/no-client-pos-error-log-writes\.test\.ts$/,
];

describe("POS architecture guard — pos_error_log is RPC-only from the client", () => {
  it("no client file performs .insert/.update/.upsert/.delete on pos_error_log", () => {
    const candidates = execSync(
      'rg --files-with-matches "pos_error_log" src/ || true',
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
        /\bfrom\s*\(\s*["']pos_error_log["']\s*\)[\s\S]{0,400}?\.(insert|update|upsert|delete)\s*\(/;
      if (re.test(stripped)) offenders.push(p);
    }

    expect(
      offenders,
      `Client files mutating pos_error_log directly:\n${offenders.join("\n")}\n` +
        "Use the log_pos_error RPC (via reportPOSError in src/lib/pos/posErrorChannel.ts) instead.",
    ).toEqual([]);
  });
});
