import { describe, it, expect } from "vitest";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * Phase 2 — consequence preview.
 *
 * Locks two invariants:
 *
 * 1. No reversal is authorised blind. Every confirmation surface that can post a
 *    reversal renders `ReversalConsequencePreview` and keeps its confirm action
 *    disabled while the preview is loading or errored.
 * 2. The preview is a projection, not a second source of truth. It must not read
 *    Supabase and must not re-derive accounting, inventory or settlement
 *    figures — the server walks the same predicates the void writers walk, and a
 *    client-side derivation would drift from what actually posts.
 */

const PROJECT_ROOT = process.cwd();
const SRC = join(PROJECT_ROOT, "src");
const MIGRATIONS_DIR = join(PROJECT_ROOT, "supabase", "migrations");

const PREVIEW_COMPONENT = join(SRC, "components", "reversal", "ReversalConsequencePreview.tsx");
const FETCH_HOOK = join(SRC, "components", "reversal", "useReversalConsequences.ts");
const HOOK = join(SRC, "hooks", "useTransactionReversal.ts");

/** Surfaces where an operator authorises a reversal. */
const CONFIRMATION_SURFACES = [
  join(SRC, "components", "invoices", "VoidInvoiceDialog.tsx"),
  join(SRC, "components", "payments", "ReversePaymentWizard.tsx"),
];

function read(path: string): string {
  return readFileSync(path, "utf8");
}

describe("Phase 2 — the preview projection exists end to end", () => {
  it("the database exposes preview_reversal_consequences", () => {
    const defined = readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith(".sql"))
      .some((f) =>
        /FUNCTION\s+public\.preview_reversal_consequences\b/i.test(
          readFileSync(join(MIGRATIONS_DIR, f), "utf8"),
        ),
      );
    expect(defined, "no migration defines public.preview_reversal_consequences").toBe(true);
  });

  it("the hook wraps the RPC and exports it", () => {
    const src = read(HOOK);
    expect(src).toMatch(/previewReversalConsequences/);
    expect(src, "the wrapper does not call the preview RPC").toMatch(
      /rpc\(\s*["']preview_reversal_consequences["']/,
    );
  });

  it("the preview component and its fetch container exist", () => {
    expect(existsSync(PREVIEW_COMPONENT)).toBe(true);
    expect(existsSync(FETCH_HOOK)).toBe(true);
  });
});

describe("Phase 2 — the preview stays a pure projection", () => {
  it("does not touch Supabase directly", () => {
    const src = read(PREVIEW_COMPONENT);
    expect(src, "ReversalConsequencePreview must not query Supabase").not.toMatch(
      /integrations\/supabase|supabase\.(from|rpc)\(/,
    );
  });

  it("does not re-derive the reversal figures it renders", () => {
    const src = read(PREVIEW_COMPONENT);
    // Client-side arithmetic over server figures is how a preview starts
    // disagreeing with the writer. Totals come from the RPC.
    expect(src, "totals must come from the RPC, not a client reduce/sum").not.toMatch(
      /\.reduce\(|total_reversed\s*=|amount_paid_after\s*=/,
    );
  });
});

describe("Phase 2 — every reversal confirmation surface renders the preview", () => {
  for (const file of CONFIRMATION_SURFACES) {
    const name = file.split("/").slice(-1)[0];

    it(`${name} renders ReversalConsequencePreview`, () => {
      const src = read(file);
      expect(src, `${name} does not import the preview`).toMatch(
        /from\s+["']@\/components\/reversal\/ReversalConsequencePreview["']/,
      );
      expect(src, `${name} imports but never renders the preview`).toMatch(
        /<ReversalConsequencePreview/,
      );
    });

    it(`${name} blocks confirmation while the preview is unavailable`, () => {
      const src = read(file);
      expect(src, `${name} does not consume the preview state`).toMatch(
        /isPreviewLoading/,
      );
      expect(
        src,
        `${name} allows confirming while the preview is loading or errored`,
      ).toMatch(/isPreviewLoading\s*\|\|\s*[\s\S]{0,40}isPreviewError/);
    });
  }
});
