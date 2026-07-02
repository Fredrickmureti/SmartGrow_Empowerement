/**
 * Stage 8 architecture guard — `pos_shifts` is RPC-only for status changes
 * from the client. The DB also enforces this via
 * `trg_pos_shifts_no_client_status_flip`; this guard catches the offence at
 * code-review time.
 *
 * Allowed:
 *  - openShift insert (bounded by partial unique indexes + RLS branch scope)
 *  - read-only paths (.select)
 *
 * Banned: any client-side .update / .upsert / .delete on `pos_shifts`.
 * Use close_pos_shift / force_close_pos_shift / reopen_pos_shift instead.
 */
import { describe, it, expect } from "vitest";
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";

const ALLOWLIST = [
  /^src\/integrations\/supabase\/types\.ts$/,
  /^src\/test\/architecture\/no-client-pos-shift-writes\.test\.ts$/,
  /^src\/hooks\/pos\/usePOSShifts\.ts$/, // openShift insert is bounded
  /^src\/components\/pos\/POSDataResetTool\.tsx$/, // dev-only reset RPC caller
];

describe("POS architecture guard — pos_shifts is RPC-only from the client", () => {
  it("no client file performs .update/.upsert/.delete on pos_shifts", () => {
    const candidates = execSync(
      'rg --files-with-matches "pos_shifts" src/ || true',
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
        /\bfrom\s*\(\s*["']pos_shifts["']\s*\)[\s\S]{0,400}?\.(update|upsert|delete)\s*\(/;
      if (re.test(stripped)) offenders.push(p);
    }

    expect(
      offenders,
      `Client files mutating pos_shifts directly:\n${offenders.join("\n")}\n` +
        "Use close_pos_shift / force_close_pos_shift / reopen_pos_shift RPCs instead.",
    ).toEqual([]);
  });
});
