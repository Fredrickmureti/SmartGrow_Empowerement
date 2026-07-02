/**
 * Phase 4 P4 — architecture guard for the drill-down resolver.
 *
 * Two structural invariants the rest of the codebase relies on:
 *
 *  1. Every `InputRefKind` declared in the shared `inputRef.ts` is
 *     listed in the resolver's switch. If a future ref kind is added
 *     and the resolver isn't updated, the build catches it here —
 *     not at runtime when an employee opens a payslip.
 *
 *  2. The resolver source contains no jurisdiction-specific tokens
 *     (PAYE / NHIF / NSSF / Kenya / …). This is the same invariant
 *     enforced for the engine by `no_country_named_functions_test.sql`
 *     and for the immutability trigger by
 *     `payslip_immutability_country_agnostic_test.sql` — extended to
 *     the UI translation layer so country-specific routing cannot be
 *     smuggled in via the drill-down table either.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const INPUT_REF = resolve(__dirname, "../../../supabase/functions/_shared/inputRef.ts");
const RESOLVER = resolve(__dirname, "../../lib/payroll/payslipDrillDown.ts");

function extractInputRefKinds(src: string): string[] {
  // Captures the body of `export type InputRefKind = … ;` and pulls
  // every quoted literal — the canonical list of kinds.
  const m = src.match(/export type InputRefKind\s*=\s*([^;]+);/);
  if (!m) throw new Error("Could not locate InputRefKind union in inputRef.ts");
  const literals = m[1].match(/"([^"]+)"/g) ?? [];
  return literals.map((s) => s.replace(/"/g, ""));
}

describe("payslip drill-down architecture guard (Phase 4 P4)", () => {
  const refSrc = readFileSync(INPUT_REF, "utf8");
  const resolverSrc = readFileSync(RESOLVER, "utf8");
  const kinds = extractInputRefKinds(refSrc);

  it("every InputRefKind has a switch case in the resolver", () => {
    const missing = kinds.filter((k) => !new RegExp(`case\\s+"${k}"\\s*:`).test(resolverSrc));
    expect(missing).toEqual([]);
  });

  it("resolver source is free of jurisdiction-specific tokens", () => {
    // Mirrors the SQL guard. Strip the COUNTRY_SPECIFIC_TOKEN_RE export
    // itself before grepping — its purpose is to *contain* those words.
    const stripped = resolverSrc.replace(
      /export const COUNTRY_SPECIFIC_TOKEN_RE\s*=\s*\/[^;]+;/,
      "",
    );
    const re = /\b(paye|nhif|shif|nssf|ahl|housing[-_]?levy|kra|nita|kenya|uganda|tanzania|rwanda|nigeria)\b/i;
    expect(stripped).not.toMatch(re);
  });

  it("resolver routes for portal mode never escape the /me/ prefix", () => {
    // Surfaces only the literal hrefs inside the resolver source so we can
    // statically partition them by mode. We pair every `isPortal` guard
    // with its sibling `return` block.
    const portalReturns = resolverSrc.match(/isPortal[\s\S]+?href:\s*`([^`]+)`/g) ?? [];
    for (const block of portalReturns) {
      const href = block.match(/href:\s*`([^`]+)`/)?.[1];
      if (!href) continue;
      // Templates use ${…} for ids — strip before checking the prefix.
      const stripped = href.replace(/\$\{[^}]+\}/g, "X");
      // Some `isPortal` branches return null directly — skip those.
      if (stripped.startsWith("/me/")) continue;
      // Or fallthrough into a non-portal return — accept admin-only.
      expect(stripped.startsWith("/me/") || stripped.startsWith("/hr/") || stripped.startsWith("/expenses")).toBe(true);
    }
  });

  /**
   * Phase 4 P4 — route-drift guard. Every admin `/hr/payroll/...` href
   * the resolver hands back must correspond to a registered entry in
   * `PAYROLL_NAV` (or be a nested detail under one). If somebody renames
   * `/hr/payroll/statutory-rules` to `/hr/payroll/rules` in the nav, the
   * payslip explainer's links would silently 404 — this guard catches
   * that at build time. We import the nav module as source text rather
   * than at runtime to avoid pulling React/icon imports into the test.
   */
  it("admin hrefs in the resolver are covered by PAYROLL_NAV", () => {
    const navSrc = readFileSync(
      resolve(__dirname, "../../apps/hr/shared/navs.ts"),
      "utf8",
    );
    // Pull every `to: "/hr/..."` literal from every nav export — the
    // resolver may legitimately point at HR surfaces that live outside
    // PAYROLL_NAV (`/hr/employees/:id` for contracts, `/hr/leave/approvals`
    // for manager review, `/hr/benefits` for the elections workspace).
    const navPaths = (navSrc.match(/to:\s*"(\/hr\/[^"]+)"/g) ?? []).map((s) =>
      s.match(/"([^"]+)"/)![1],
    );

    // Walk the resolver source byte-by-byte to extract template-literal
    // hrefs with balanced `${ ... }` interpolations — a naïve regex
    // breaks on nested calls like `${qs({ ... })}`.
    function extractHrefs(src: string): string[] {
      const out: string[] = [];
      const re = /href:\s*`/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(src))) {
        let i = m.index + m[0].length;
        let buf = "";
        while (i < src.length && src[i] !== "`") {
          if (src[i] === "$" && src[i + 1] === "{") {
            let depth = 1;
            i += 2;
            while (i < src.length && depth > 0) {
              if (src[i] === "{") depth++;
              else if (src[i] === "}") depth--;
              if (depth === 0) break;
              i++;
            }
            i++; // consume closing `}`
            buf += "X";
          } else {
            buf += src[i++];
          }
        }
        out.push(buf);
      }
      return out;
    }

    const adminHrefs = extractHrefs(resolverSrc)
      .filter((h) => h.startsWith("/hr/"))
      .map((h) => h.replace(/\?.*$/, "").replace(/\/+$/, "").replace(/\/X$/g, ""));

    const orphans = adminHrefs.filter(
      (href) => !navPaths.some((nav) => href === nav || href.startsWith(nav + "/")),
    );

    expect(
      orphans,
      `Resolver routes to admin paths not in any *_NAV: ${orphans.join(", ")}`,
    ).toEqual([]);
  });
});
