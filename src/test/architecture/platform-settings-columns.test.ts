/**
 * Architecture guard — fails CI if any source file queries
 * `platform_settings` using the wrong column names (`key` / `value`).
 *
 * The actual columns are `setting_key` / `setting_value`. A regression in
 * AdminLogin.tsx broke the platform-admin login flow with a 400 Bad
 * Request because it used the wrong names. This guard catches the
 * pattern statically.
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const SCOPE = "src";

function walk(dir: string, out: string[] = []): string[] {
  let entries: string[] = [];
  try { entries = readdirSync(dir); } catch { return out; }
  for (const entry of entries) {
    if (entry === "node_modules" || entry === ".git") continue;
    const full = join(dir, entry);
    let s: ReturnType<typeof statSync>;
    try { s = statSync(full); } catch { continue; }
    if (s.isDirectory()) walk(full, out);
    else if (/\.(ts|tsx|js|jsx)$/.test(entry)) out.push(full);
  }
  return out;
}

describe("platform-settings-columns architecture guard", () => {
  it("no .from('platform_settings') chain uses the wrong column names", () => {
    const offenders: string[] = [];
    for (const file of walk(SCOPE)) {
      if (file.endsWith("platform-settings-columns.test.ts")) continue;
      if (file.endsWith("integrations/supabase/types.ts")) continue;
      const src = readFileSync(file, "utf8");
      // Find each .from('platform_settings') call and inspect the next ~400 chars.
      const re = /\.from\(\s*["'`]platform_settings["'`]\s*\)([\s\S]{0,400})/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(src))) {
        const tail = m[1];
        // Disallow .select("value") / .select("…, value, …") and .eq("key", …)
        // The wrong pattern is: select("value") or eq("key", …).
        const wrongSelect = /\.select\(\s*["'`][^"'`]*\bvalue\b[^"'`]*["'`]\s*\)/.test(tail) &&
                            !/\bsetting_value\b/.test(tail.match(/\.select\([^)]*\)/)?.[0] ?? "");
        const wrongEq = /\.eq\(\s*["'`]key["'`]\s*,/.test(tail);
        if (wrongSelect || wrongEq) {
          const line = src.slice(0, m.index).split("\n").length;
          offenders.push(`${file}:${line}  ::  uses 'key'/'value' instead of 'setting_key'/'setting_value'`);
        }
      }
    }
    if (offenders.length > 0) {
      throw new Error(
        `platform_settings has columns 'setting_key'/'setting_value', not 'key'/'value':\n` +
          offenders.join("\n"),
      );
    }
    expect(offenders).toEqual([]);
  });
});
