/**
 * Guard: ADR 0137 — FX/integration provider credentials are server-only.
 *
 * The browser may never read `credentials` from platform_integration_connections,
 * and may never write that table directly. All writes go through the guarded
 * SECURITY DEFINER routines.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const SRC = join(process.cwd(), "src");

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === "test" || entry === "node_modules") continue;
      walk(full, out);
    } else if (/\.(ts|tsx)$/.test(entry) && !full.includes("integrations/supabase/types")) {
      out.push(full);
    }
  }
  return out;
}

const files = walk(SRC).map((f) => ({ path: f, text: readFileSync(f, "utf8") }));

const TABLE = "platform_integration_connections";

describe("ADR 0137 — provider credential isolation", () => {
  it("no client file selects * from platform_integration_connections", () => {
    const re = new RegExp(
      `from\\(\\s*["'\`]${TABLE}["'\`]\\s*\\)[\\s\\S]{0,200}?\\.select\\(\\s*["'\`]\\*["'\`]\\s*\\)`,
    );
    const offenders = files.filter((f) => re.test(f.text));
    expect(offenders.map((o) => o.path)).toEqual([]);
  });

  it("no client file reads the credentials column of a connection", () => {
    const offenders = files.filter(
      (f) =>
        f.text.includes(TABLE) &&
        /connection[^\n]*\.credentials|activeConnection\.credentials/.test(f.text),
    );
    expect(offenders.map((o) => o.path)).toEqual([]);
  });

  it("client writes to the connections table go through the guarded RPCs", () => {
    const offenders = files.filter((f) => {
      if (!f.text.includes(TABLE)) return false;
      // any .from("platform_integration_connections") followed by a mutation verb
      const re = new RegExp(
        `from\\(\\s*["'\`]${TABLE}["'\`]\\s*\\)[\\s\\S]{0,120}?\\.(insert|update|upsert|delete)\\(`,
      );
      return re.test(f.text);
    });
    expect(offenders.map((o) => o.path)).toEqual([]);
  });

  it("the providers hook exposes credential metadata but not values", () => {
    const hook = readFileSync(join(SRC, "hooks/useIntegrationProviders.ts"), "utf8");
    expect(hook).toContain("credential_keys");
    expect(hook).toContain("credentials_set_at");
    expect(hook).toContain("save_integration_connection");
    expect(hook).toContain("delete_integration_connection");
    expect(hook).not.toMatch(/credentials:\s*Record<string, string>;\s*\n\s*config:/);
  });
});
