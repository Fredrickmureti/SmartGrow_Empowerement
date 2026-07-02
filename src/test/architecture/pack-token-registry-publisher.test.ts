import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * M10 — pack publishers must be able to manage their own pack's tokens
 * (platform-reserved rows with pack_id IS NULL remain admin-only), and
 * the publish snapshot must include `pack_token_registry` so token
 * changes ship with the pack version.
 */
describe("pack_token_registry — publisher self-serve", () => {
  it("has a publisher-scoped policy in migrations", () => {
    const dir = "supabase/migrations";
    const files = readdirSync(dir).filter((f) => f.endsWith(".sql"));
    const found = files.some((f) => {
      const sql = readFileSync(join(dir, f), "utf8");
      return /CREATE POLICY[^;]+pack_token_registry[\s\S]*?is_pack_publisher/i.test(
        sql,
      );
    });
    expect(found).toBe(true);
  });

  it("publish snapshot includes pack_token_registry", () => {
    const src = readFileSync(
      "supabase/functions/publish-localization-pack-version/index.ts",
      "utf8",
    );
    expect(src).toMatch(/PACK_TABLES[\s\S]*pack_token_registry/);
  });
});