/**
 * Architecture guard — fails CI if frontend code writes branch identity
 * fields (logo_url, receipt_header, receipt_footer, slogan, tagline,
 * letterhead_url, signature_url, brand_*) directly onto the `branches`
 * table.
 *
 * The canonical store for branch overrides is `branch_setting_overrides`
 * (JSON, whitelisted by `branch_overridable_settings`). Writing those
 * keys back onto `branches.*` would resurrect the dual-writer that the
 * Phase B migration eliminated and silently desync the resolver.
 *
 * Reads of those columns are still allowed for backfill/diagnostic UI;
 * only `.update(...)` / `.upsert(...)` / `.insert(...)` payloads that
 * carry an identity key are flagged.
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, extname } from "node:path";

const SRC_DIR = "src";
const SKIP_DIRS = new Set([
  "node_modules",
  "dist",
  "build",
  ".next",
  ".turbo",
  "test",
  "__tests__",
]);
const ALLOWED_EXT = new Set([".ts", ".tsx"]);

const IDENTITY_KEYS = [
  "logo_url",
  "receipt_header",
  "receipt_footer",
  "slogan",
  "tagline",
  "letterhead_url",
  "signature_url",
  "brand_primary_color",
  "brand_secondary_color",
];

function walk(dir: string, out: string[] = []): string[] {
  let entries: string[] = [];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    if (SKIP_DIRS.has(name)) continue;
    const p = join(dir, name);
    let s;
    try {
      s = statSync(p);
    } catch {
      continue;
    }
    if (s.isDirectory()) walk(p, out);
    else if (ALLOWED_EXT.has(extname(p))) out.push(p);
  }
  return out;
}

/**
 * Detect a Supabase write into the `branches` table that carries one of
 * the forbidden identity keys in its payload.
 *
 * We scan for `.from("branches")` (or 'branches') in the same file that
 * also contains `.update(` / `.upsert(` / `.insert(` with an object
 * literal that mentions an identity key. This is intentionally
 * conservative — any genuine write must be reshaped to go through
 * `branch_setting_overrides` instead.
 */
function findViolations(file: string, src: string): string[] {
  const touchesBranches =
    /\.from\(\s*['"]branches['"]\s*\)/.test(src) ||
    /supabase[^\n]*\.from\(\s*['"]branches['"]\s*\)/.test(src);
  if (!touchesBranches) return [];

  const writeRe = /\.(update|upsert|insert)\s*\(\s*\{([\s\S]*?)\}/g;
  const violations: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = writeRe.exec(src)) !== null) {
    const payload = m[2];
    for (const key of IDENTITY_KEYS) {
      const keyRe = new RegExp(`(^|[\\s,{])${key}\\s*:`, "m");
      if (keyRe.test(payload)) {
        violations.push(`${file}: .${m[1]}({ … ${key}: … }) on branches`);
      }
    }
  }
  return violations;
}

describe("Branch identity — no direct writes onto branches.*", () => {
  it("no frontend code writes identity keys into the branches table", () => {
    const files = walk(SRC_DIR);
    const all: string[] = [];
    for (const f of files) {
      const src = readFileSync(f, "utf8");
      all.push(...findViolations(f, src));
    }
    expect(
      all,
      "Direct write to branches.<identity> detected. Route through " +
        "`branch_setting_overrides` (JSON) instead — see " +
        "INVENTORY_ARCHITECTURE.md / Settings audit Phase B.\n" +
        all.join("\n"),
    ).toEqual([]);
  });
});
