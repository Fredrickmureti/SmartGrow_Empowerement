/**
 * Guard: the printer-role *branch binding* pipeline is gone.
 *
 * Migration 20260727234102 dropped `public.printer_role_branch_bindings`
 * and the `resolve_hardware_assignment` RPC. Device selection is now
 * `resolve_device(role, business_id, scope_kind, scope_id)` reading
 * `device_assignments` directly. The 2026-07-28 audit found the Printer
 * roles admin page still querying the dropped table (every query 404'd
 * against PostgREST) — an admin surface that silently failed.
 *
 * These tests stop the phantom pipeline from being reintroduced in app
 * code. Migrations are excluded: history is immutable and legitimately
 * contains the original CREATE/DROP statements.
 */
import { describe, it, expect } from "vitest";
import { execSync } from "node:child_process";

const DROPPED = ["printer_role_branch_bindings", "resolve_hardware_assignment"];

function grep(term: string): string[] {
  try {
    const out = execSync(
      `rg -l --fixed-strings ${JSON.stringify(term)} src supabase/functions electron agent || true`,
      { encoding: "utf8", cwd: process.cwd() },
    );
    return out.split("\n").map((l) => l.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

describe("dropped printer-role binding pipeline", () => {
  for (const term of DROPPED) {
    it(`no app code references \`${term}\``, () => {
      const hits = grep(term).filter((f) => !f.includes("dropped-printer-role-bindings"));
      expect(hits, `\`${term}\` was dropped from the database; these files still reference it:\n${hits.join("\n")}`).toEqual([]);
    });
  }
});
