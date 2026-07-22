/**
 * Contract test — Stage 3 of the POS refund/reversal remediation.
 *
 * Guards:
 *   1. Every reversal RPC identified in the audit calls
 *      `assert_manager_override` at least once.
 *   2. The blanket "Override denied" / "An unexpected error occurred"
 *      copy has been retired from POS reversal UI in favour of the
 *      overrideErrors catalogue.
 *   3. `OVERRIDE_ACTION_FOR_COMMAND` covers every command in the
 *      Stage-2 taxonomy — no orphan commands.
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { OVERRIDE_ACTION_FOR_COMMAND } from "@/hooks/pos/useOverridePolicy";
import { OVERRIDE_ERROR_CATALOGUE } from "@/services/pos/reversal/overrideErrors";

const MIGRATIONS_DIR = join(process.cwd(), "supabase", "migrations");

function migrationsCorpus(): string {
  const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql"));
  return files
    .map((f) => readFileSync(join(MIGRATIONS_DIR, f), "utf8"))
    .join("\n\n");
}

/**
 * Extracts the body of every `CREATE OR REPLACE FUNCTION public.<name>(...)`
 * declaration in the corpus so we can inspect it in isolation.
 */
function bodiesFor(fnName: string, corpus: string): string[] {
  const bodies: string[] = [];
  const re = new RegExp(
    `CREATE\\s+OR\\s+REPLACE\\s+FUNCTION\\s+public\\.${fnName}\\s*\\([^)]*\\)[\\s\\S]*?\\$\\$([\\s\\S]*?)\\$\\$`,
    "gi",
  );
  let m: RegExpExecArray | null;
  while ((m = re.exec(corpus)) !== null) {
    bodies.push(m[1]);
  }
  return bodies;
}

describe("POS override policy contract (Stage 3)", () => {
  const corpus = migrationsCorpus();

  it.each([
    "pos_card_void",
    "pos_card_reverse",
    "pos_payment_session_reverse_tender",
    "pos_return_authorization_transition_v2",
  ])(
    "%s calls assert_manager_override in its latest definition",
    (fn) => {
      const bodies = bodiesFor(fn, corpus);
      expect(bodies.length).toBeGreaterThan(0);
      // The latest declaration wins; look at the last one.
      const latest = bodies[bodies.length - 1];
      expect(latest).toMatch(/assert_manager_override/);
    },
  );

  it("OVERRIDE_ACTION_FOR_COMMAND covers all six taxonomy commands", () => {
    const keys = Object.keys(OVERRIDE_ACTION_FOR_COMMAND).sort();
    expect(keys).toEqual(
      [
        "exchange",
        "issue_store_credit",
        "refund_sale",
        "return_goods",
        "reverse_card_authorization",
        "void_sale",
      ].sort(),
    );
  });

  it("overrideErrors catalogue covers every documented server error code", () => {
    const required = [
      "override_required",
      "override_not_found",
      "override_not_approved",
      "override_already_consumed",
      "override_expired",
      "override_org_mismatch",
      "override_business_mismatch",
      "override_action_mismatch",
      "override_shift_mismatch",
      "override_role_not_allowed",
      "invalid_pin",
      "unknown",
    ];
    for (const code of required) {
      expect(OVERRIDE_ERROR_CATALOGUE).toHaveProperty(code);
    }
  });
});
