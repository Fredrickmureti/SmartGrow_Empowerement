/**
 * Contract test for Stage 1 of the POS refund/reversal remediation
 * (see `.lovable/plan.md`).
 *
 * Two invariants:
 *
 * 1. `useManagerOverride` MUST be called with zero arguments or a
 *    single envelope-override object. The legacy positional
 *    `useManagerOverride(orgId, businessId?)` shape is banned — it
 *    was the exact defect that produced "Company not selected →
 *    Override denied" at five call sites.
 *
 * 2. Envelope-critical fields (`organizationId`, `businessId`) MUST
 *    NOT be re-derived at hook-call sites via `useOrganization()` /
 *    `useBusinesses()` and then threaded into `useManagerOverride`.
 *    The envelope is the single source of truth.
 *
 * Grep-based source contract in the project's standard architecture
 * pattern (see `src/test/architecture/*` and
 * `src/test/payments/refund-*`).
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(process.cwd(), "src");

function walk(dir: string, acc: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name.startsWith(".")) continue;
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, acc);
    else if (/\.tsx?$/.test(name)) acc.push(full);
  }
  return acc;
}

const ALL_TS = walk(ROOT);

const CALL_SITE_FILES = ALL_TS.filter((f) => {
  const src = readFileSync(f, "utf8");
  return /useManagerOverride\s*\(/.test(src);
});

describe("Stage 1 — TerminalSessionEnvelope contract", () => {
  it("finds every useManagerOverride call site (sanity)", () => {
    // If this fails to zero the file didn't ship the hook name, this
    // suite has become useless.
    expect(CALL_SITE_FILES.length).toBeGreaterThan(0);
  });

  it("no call site passes a scalar id as first argument", () => {
    // Legal:   useManagerOverride()               — read ambient envelope
    //          useManagerOverride({...})          — envelope override
    // Illegal: useManagerOverride(currentOrg?.id) — scalar id, drops businessId
    //          useManagerOverride(a, b)           — positional org+business
    const offenders: Array<{ file: string; snippet: string }> = [];
    const scalarPattern =
      /useManagerOverride\s*\(\s*([^)]*?)\)/gs;
    const scalarLike =
      /(\.id\b|\borganizationId\b|\bcompanyId\b|\borgId\b|\bbusinessId\b)/;

    for (const file of CALL_SITE_FILES) {
      // Skip the hook definition itself.
      if (file.endsWith("useManagerOverride.ts")) continue;
      // Skip the envelope module (contains illegal examples in doc comments).
      if (file.endsWith("TerminalSessionEnvelope.ts")) continue;
      // Skip this test file.
      if (file.endsWith("terminal-session-envelope.test.ts")) continue;
      // Skip the ESLint rule file (contains illegal examples in comments).
      if (file.includes("eslint-rules")) continue;
      const src = readFileSync(file, "utf8");
      for (const match of src.matchAll(scalarPattern)) {
        const args = match[1].trim();
        if (args === "") continue; // zero-arg legal
        if (args.startsWith("{")) continue; // object override legal
        // Two-argument positional is always illegal, no matter what.
        // Single-arg scalar-looking is illegal.
        if (args.includes(",") || scalarLike.test(args)) {
          offenders.push({ file, snippet: `useManagerOverride(${args})` });
        }
      }
    }

    expect(
      offenders,
      `Illegal useManagerOverride call sites detected. Pass an envelope-override object.\n${offenders
        .map((o) => `  ${o.file}: ${o.snippet}`)
        .join("\n")}`,
    ).toEqual([]);
  });

  it("useManagerOverride hook signature exposes only the envelope-override form", () => {
    const source = readFileSync(
      join(ROOT, "hooks/pos/useManagerOverride.ts"),
      "utf8",
    );
    // Legacy positional form MUST NOT reappear.
    expect(source).not.toMatch(
      /useManagerOverride\s*\(\s*organizationId\s*:/,
    );
    // Envelope-based signature MUST be present.
    expect(source).toMatch(
      /useManagerOverride\s*\(\s*overrides\??\s*:\s*Partial<TerminalSessionEnvelope>/,
    );
    // Must use the assert helper for structured field errors.
    expect(source).toMatch(/assertActiveTerminalSession\s*\(/);
    // Must handle TerminalSessionMissingFieldError distinctly from
    // the blanket "Override Denied" toast.
    expect(source).toMatch(/TerminalSessionMissingFieldError/);
  });

  it("the historical 'Company not selected' literal is gone from the hook", () => {
    const source = readFileSync(
      join(ROOT, "hooks/pos/useManagerOverride.ts"),
      "utf8",
    );
    expect(source).not.toMatch(/Company not selected/);
  });

  it("envelope module exposes the required public surface", () => {
    const source = readFileSync(
      join(ROOT, "services/pos/session/TerminalSessionEnvelope.ts"),
      "utf8",
    );
    for (const symbol of [
      "TerminalSessionEnvelope",
      "ActiveTerminalSession",
      "useTerminalSessionEnvelope",
      "mergeEnvelope",
      "assertActiveTerminalSession",
      "TerminalSessionMissingFieldError",
      "describeMissingField",
    ]) {
      expect(source, `envelope module missing export: ${symbol}`).toMatch(
        new RegExp(`\\b${symbol}\\b`),
      );
    }
  });
});
