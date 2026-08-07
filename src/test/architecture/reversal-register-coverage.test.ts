/**
 * Architecture guard (ADR 0129, Phase 5.4).
 *
 * `public.reversal_register` is the single cross-module reporting surface for
 * business reversals. Every reversible document declared in
 * `src/services/reversal/registerModules.ts` MUST contribute a branch to that
 * view, otherwise a module could reverse business state that never appears in
 * the period register — exactly the drift the register exists to prevent.
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { REVERSIBLE_DOCUMENTS } from "../../services/reversal/registerModules";

const migrationsDir = resolve(__dirname, "../../../supabase/migrations");

const registerDefinition = (): string => {
  const files = readdirSync(migrationsDir)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  const matches = files
    .map((f) => readFileSync(resolve(migrationsDir, f), "utf8"))
    .filter((sql) => /VIEW\s+public\.reversal_register/i.test(sql));
  expect(
    matches.length,
    "no migration defines public.reversal_register",
  ).toBeGreaterThan(0);
  // The latest definition is authoritative.
  return matches[matches.length - 1];
};

describe("reversal register coverage", () => {
  const sql = registerDefinition();

  it("is a security-invoker view so document RLS still applies", () => {
    expect(sql).toMatch(/security_invoker\s*=\s*true/i);
  });

  it.each(REVERSIBLE_DOCUMENTS.map((d) => [d.documentType, d.table] as const))(
    "covers %s from %s",
    (documentType, table) => {
      expect(sql).toContain(`'${documentType}'`);
      expect(sql).toMatch(new RegExp(`public\\.${table}\\b`));
    },
  );

  it.each(Array.from(new Set(REVERSIBLE_DOCUMENTS.map((d) => d.module))))(
    "labels the %s module",
    (module) => {
      expect(sql).toContain(`'${module}'`);
    },
  );

  it("exposes the reporting columns the finance surface reads", () => {
    for (const col of [
      "document_number",
      "document_date",
      "reversal_date",
      "reason_code",
      "reason_comment",
      "reversed_by",
      "reversal_kind",
      "approval_request_id",
    ]) {
      expect(sql).toContain(col);
    }
  });
});
