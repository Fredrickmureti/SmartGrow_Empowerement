/**
 * Guard against regressing audit_logs.action vocabulary.
 *
 * `audit_logs_action_check` only allows past-tense values
 * ('created', 'updated', 'deleted', 'posted', 'reversed', 'paid', ...).
 * A trigger writing 'create' / 'update' / 'delete' silently rolls back
 * every parent INSERT (this is what blocked all payroll runs in May 2026).
 */
import { describe, it, expect } from "vitest";
import { execSync } from "node:child_process";

describe("audit_logs action vocabulary", () => {
  it("no migration writes present-tense audit actions", () => {
    const out = execSync(
      `rg -nE "action[^=]*=>?\\s*'(create|update|delete)'|THEN\\s+'(create|update|delete)'" supabase/migrations/ || true`,
      { encoding: "utf8" }
    )
      .split("\n")
      .filter(Boolean)
      // Ignore the constraint definition itself and this guard's own match.
      .filter((l) => !l.includes("audit_logs_action_check"));

    expect(
      out,
      `Found present-tense audit actions (must be 'created'/'updated'/'deleted'):\n${out.join("\n")}`
    ).toEqual([]);
  });
});
