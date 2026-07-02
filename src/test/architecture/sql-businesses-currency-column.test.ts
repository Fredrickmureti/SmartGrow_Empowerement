/**
 * Architecture guard — the canonical currency column on `public.businesses`
 * is `base_currency`. Selecting a non-existent `currency_code` column from
 * `businesses` is a regression that hard-fails every dependent RPC at
 * runtime (Postgres 42703). This test scans every committed migration and
 * fails CI if the bad pattern reappears.
 *
 * Pattern caught (case-insensitive):
 *   - `businesses ... currency_code` (within ~120 chars in either order)
 *   - `b.currency_code` when joined as `businesses b`
 *
 * NOT caught (legitimate uses elsewhere):
 *   - `business_active_currencies.currency_code`
 *   - `currencies.currency_code`
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, sep, posix } from "node:path";

const ROOT = "supabase/migrations";

function walk(dir: string): string[] {
  const out: string[] = [];
  let entries: string[] = [];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    const p = join(dir, name);
    const s = statSync(p);
    if (s.isDirectory()) out.push(...walk(p));
    else if (/\.sql$/i.test(name)) out.push(p);
  }
  return out;
}

function toPosix(p: string): string {
  return p.split(sep).join(posix.sep);
}

describe("architecture: businesses.currency_code is forbidden", () => {
  it("no migration selects currency_code from public.businesses", () => {
    const files = walk(ROOT);
    const offenders: string[] = [];
    // Historical migrations that introduced the regression. Superseded by
    // the 2026-05-12 fix migration. Do not edit historical migration files.
    const HISTORICAL = new Set<string>(
      [
        "supabase/migrations/20260511004939_31379912-872c-4f43-a00c-eff806f3219a.sql",
      ].map((p) => p.split("/").join(sep)),
    );
    const direct = /\b(public\.)?businesses\.currency_code\b/i;
    const selectFromBusinesses =
      /select[\s\S]{0,200}\bcurrency_code\b[\s\S]{0,200}\bfrom\s+(public\.)?businesses\b/i;
    for (const f of files) {
      if (HISTORICAL.has(f)) continue;
      const src = readFileSync(f, "utf8");
      if (direct.test(src) || selectFromBusinesses.test(src)) {
        offenders.push(toPosix(f));
      }
    }
    expect(
      offenders,
      `Migrations must select \`base_currency\` from public.businesses, ` +
        `never \`currency_code\`. Offenders:\n${offenders.join("\n")}`,
    ).toEqual([]);
  });
});
