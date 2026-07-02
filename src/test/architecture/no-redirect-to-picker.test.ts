/**
 * Architecture invariant: URL = user intent, not loading bookkeeping.
 *
 * Route guards must never `<Navigate>` or `navigate(...)` to
 * `/select-organization` to signal an empty/loading workspace state —
 * that produces the "flash /select-organization?returnTo=…" defect on
 * reload. Empty states render in place via NoWorkspaceEmptyState; the
 * picker URL is reachable ONLY via explicit user intent or the one-shot
 * post-login resolver.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect } from "vitest";

const ALLOWED_FILES = new Set<string>([
  // The picker page itself.
  "src/pages/SelectOrganization.tsx",
  // Explicit user-clicked recovery action.
  "src/components/common/WorkspaceRecoveryCard.tsx",
  // Explicit "Switch workspace" CTA in the empty state.
  "src/components/common/NoWorkspaceEmptyState.tsx",
  // One-shot post-login destination resolvers.
  "src/lib/auth/flowRouter.ts",
  "src/lib/auth/postLoginRedirect.ts",
  // This test, and the doc comment in SessionContext that mentions the URL.
  "src/test/architecture/no-redirect-to-picker.test.ts",
]);

const PATTERN = /(?:<Navigate\s+[^>]*to\s*=\s*["'`]\/select-organization|navigate\(\s*["'`]\/select-organization)/;

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    const s = statSync(p);
    if (s.isDirectory()) {
      if (entry === "node_modules" || entry.startsWith(".")) continue;
      walk(p, out);
    } else if (/\.(ts|tsx)$/.test(entry)) {
      out.push(p);
    }
  }
  return out;
}

describe("workspace picker is never a control-flow target", () => {
  it("no guard redirects to /select-organization", () => {
    const files = walk("src");
    const offenders: string[] = [];
    for (const f of files) {
      const rel = f.replace(/\\/g, "/");
      if (ALLOWED_FILES.has(rel)) continue;
      const src = readFileSync(f, "utf8");
      // Match only on lines that aren't comments (avoid doc strings).
      const lines = src.split("\n");
      const hit = lines.some((line) => {
        const trimmed = line.trim();
        if (trimmed.startsWith("//") || trimmed.startsWith("*")) return false;
        return PATTERN.test(line);
      });
      if (hit) offenders.push(rel);
    }
    expect(
      offenders,
      `These files redirect to /select-organization as control flow.\n` +
        `Render <NoWorkspaceEmptyState/> in place instead.\n` +
        offenders.map((o) => `  - ${o}`).join("\n"),
    ).toEqual([]);
  });
});
