/**
 * Architecture guard — fails CI if a future migration re-introduces a
 * colliding overload of `public.seed_app_data`.
 *
 * The canonical signature is exactly:
 *   seed_app_data(p_org_id uuid, p_app_id text)
 *
 * Adding any other overload — especially one with a default-valued third
 * argument like `seed_app_data(uuid, text, uuid DEFAULT NULL)` — re-creates
 * the Postgres 42725 ambiguity ("function public.seed_app_data(uuid, text)
 * is not unique") that broke install_app for every app and silently
 * half-installed dependencies during onboarding.
 *
 * Only migrations authored AFTER the cleanup are policed; the cleanup
 * migration itself drops the legacy overload and is allowed.
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const MIGRATIONS_DIR = "supabase/migrations";

/** Cleanup migration timestamp — see drop_vestigial_seed_app_data_overload. */
const CLEANUP_PREFIX = "20260428140200";

function migrationFiles(): string[] {
  let entries: string[] = [];
  try {
    entries = readdirSync(MIGRATIONS_DIR);
  } catch {
    return [];
  }
  return entries
    .filter((f) => f.endsWith(".sql"))
    .filter((f) => f > CLEANUP_PREFIX)
    .map((f) => join(MIGRATIONS_DIR, f))
    .filter((p) => {
      try {
        return statSync(p).isFile();
      } catch {
        return false;
      }
    });
}

/**
 * Match `CREATE [OR REPLACE] FUNCTION [public.]seed_app_data(<args>)`
 * (case-insensitive, multiline argument list tolerated). Captures the
 * raw argument list so we can count parameters.
 */
const CREATE_FN_RE =
  /CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+(?:public\.)?seed_app_data\s*\(([^)]*)\)/gis;

function countParams(argList: string): number {
  const trimmed = argList.trim();
  if (trimmed === "") return 0;
  // naive split on commas — sufficient because plpgsql arg lists have no
  // nested parens at the top level.
  return trimmed.split(",").map((s) => s.trim()).filter(Boolean).length;
}

describe("Architecture guard: seed_app_data overloads", () => {
  it("forbids any seed_app_data overload other than the canonical 2-arg signature", () => {
    const violations: string[] = [];
    for (const file of migrationFiles()) {
      const sql = readFileSync(file, "utf8");
      let m: RegExpExecArray | null;
      while ((m = CREATE_FN_RE.exec(sql)) !== null) {
        const args = m[1];
        const n = countParams(args);
        if (n !== 2) {
          violations.push(
            `${file}: CREATE FUNCTION seed_app_data(${args.replace(/\s+/g, " ").trim()}) ` +
              `has ${n} args; only the canonical (uuid, text) signature is permitted. ` +
              `Adding any overload reintroduces the Postgres 42725 ambiguity that broke app install.`,
          );
        }
      }
    }
    expect(violations, violations.join("\n")).toEqual([]);
  });
});
