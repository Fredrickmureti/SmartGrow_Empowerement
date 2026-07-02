/**
 * Architecture guard — post-payroll-gl validates mappings before writing JE.
 *
 * Wave-2/3 hardening: the edge function MUST call
 * `payroll_validate_post_mappings(p_run_id)` and bail on any role
 * violation BEFORE invoking `post_journal_entry_atomic`. This guard
 * verifies (by source-level inspection) that the validation call exists,
 * is unconditional, and physically precedes the JE write.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SRC = readFileSync(
  join(process.cwd(), "supabase", "functions", "post-payroll-gl", "index.ts"),
  "utf8",
);

describe("post-payroll-gl — payroll_validate_post_mappings gate", () => {
  it("invokes payroll_validate_post_mappings", () => {
    expect(SRC).toMatch(/rpc\(\s*["']payroll_validate_post_mappings["']/);
  });

  it("blocks the request when role violations are returned", () => {
    // The handler must return a 400 with `role_violation` rather than
    // continuing to post.
    expect(SRC).toMatch(/role_violation/);
    expect(SRC).toMatch(/status:\s*400/);
  });

  it("validates BEFORE calling post_journal_entry_atomic", () => {
    const validateIdx = SRC.search(
      /rpc\(\s*["']payroll_validate_post_mappings["']/,
    );
    const postIdx = SRC.search(/rpc\(\s*["']post_journal_entry_atomic["']/);
    expect(validateIdx).toBeGreaterThan(-1);
    expect(postIdx).toBeGreaterThan(-1);
    expect(
      validateIdx,
      "payroll_validate_post_mappings must be called before post_journal_entry_atomic",
    ).toBeLessThan(postIdx);
  });

  it("the validation call is not gated behind a feature flag / env toggle", () => {
    // Look at the ~400 chars immediately preceding the rpc call. It must
    // not be wrapped in `if (process.env.X)` / `Deno.env.get(...)` /
    // `featureFlag` guards.
    const idx = SRC.search(/rpc\(\s*["']payroll_validate_post_mappings["']/);
    const window = SRC.slice(Math.max(0, idx - 400), idx);
    expect(window).not.toMatch(/Deno\.env\.get\([^)]*\)\s*[!=<>]/);
    expect(window).not.toMatch(/process\.env\.[A-Z_]+\s*[!=<>]/);
    expect(window).not.toMatch(/featureFlag|FEATURE_FLAG/i);
  });
});
