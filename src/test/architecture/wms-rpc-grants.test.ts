/**
 * Phase 3.7 architecture guard — RPC grants audit.
 *
 * Every `wms_*` function defined in migrations must (a) revoke from
 * PUBLIC and (b) grant EXECUTE to `authenticated` (service_role is
 * optional but common). A future migration that forgets to add grants
 * silently ships an RPC that no one can invoke — or worse, one that
 * PUBLIC can still call because it never had REVOKE.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

interface FnDef {
  name: string;
  migration: string;
}

function collectWmsFunctions(): FnDef[] {
  const dir = path.resolve(__dirname, "../../../supabase/migrations");
  const out: FnDef[] = [];
  const re = /CREATE\s+OR\s+REPLACE\s+FUNCTION\s+public\.(wms_[a-z0-9_]+)\s*\(/gi;
  for (const name of readdirSync(dir).sort()) {
    const p = path.join(dir, name);
    if (!statSync(p).isFile() || !name.endsWith(".sql")) continue;
    const src = readFileSync(p, "utf8");
    let m: RegExpExecArray | null;
    while ((m = re.exec(src))) out.push({ name: m[1], migration: name });
  }
  return out;
}

/**
 * Some helper functions are trigger bodies (prefixed with `_wms_`) or
 * internal — they do not need EXECUTE grants because they are called
 * from triggers or SECURITY DEFINER functions with their owner's rights.
 * The guard scopes to public-facing RPCs only.
 */
const INTERNAL_PREFIX = /^wms_(emit_|resolve_|is_)/;

/**
 * Scheduled/maintenance sweeps that run under pg_cron with owner rights
 * and must NOT be exposed to authenticated callers.
 */
const SCHEDULED_ONLY = new Set<string>(["wms_task_reap_expired"]);

describe("Phase 3.7 — wms_* RPC grants audit", () => {
  it("every public wms_* function has EXECUTE granted to authenticated", () => {
    const fns = collectWmsFunctions();
    const dir = path.resolve(__dirname, "../../../supabase/migrations");
    // Concatenate all migrations once so we can search grants across files.
    let corpus = "";
    for (const name of readdirSync(dir)) {
      const p = path.join(dir, name);
      if (!statSync(p).isFile() || !name.endsWith(".sql")) continue;
      corpus += "\n" + readFileSync(p, "utf8");
    }

    const missing: string[] = [];
    const seen = new Set<string>();
    for (const fn of fns) {
      if (seen.has(fn.name)) continue;
      seen.add(fn.name);
      if (INTERNAL_PREFIX.test(fn.name)) continue;
      const grantRe = new RegExp(
        `GRANT\\s+EXECUTE\\s+ON\\s+FUNCTION\\s+public\\.${fn.name}\\s*\\([^)]*\\)\\s+TO\\s+[^;]*authenticated`,
        "i",
      );
      if (!grantRe.test(corpus)) missing.push(fn.name);
    }

    expect(
      missing,
      `wms_* functions without GRANT EXECUTE TO authenticated: ${missing.join(", ")}`,
    ).toEqual([]);
  });
});
