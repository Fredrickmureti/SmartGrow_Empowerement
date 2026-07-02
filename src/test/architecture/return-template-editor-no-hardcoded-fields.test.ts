/**
 * Architecture guard — Phase 3 (post-cutover): ReturnTemplateEditor must
 * NOT contain a hardcoded `KNOWN_SOURCES` constant. The column-source
 * picker is driven by `pack_token_registry` via `usePackTokens()`.
 *
 * History:
 *   - Phase 1 froze new statutory-ID additions to the legacy KNOWN_SOURCES
 *     constant.
 *   - Phase 3 (this audit close-out) deleted KNOWN_SOURCES entirely and
 *     wired the editor to the token registry. New countries onboard by
 *     adding pack-scoped rows to pack_token_registry — never by editing
 *     the editor.
 *
 * This guard prevents regression: if anyone re-introduces a literal
 * `KNOWN_SOURCES = [...]` array, or inlines country-specific employee
 * identifier paths in JSX, the build fails.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const FILE = "src/features/localization/components/ReturnTemplateEditor.tsx";

const FORBIDDEN_LITERAL_TOKENS = [
  "employee.nssf_number",
  "employee.nhif_number",
  "employee.shif_number",
  "employee.nita_number",
  "employee.ssnit_number",
  "employee.fgts_number",
  "employee.inss_number",
  "employee.nhf_number",
  "employee.pfa_number",
  "employee.uif_number",
];

describe("ReturnTemplateEditor is data-driven", () => {
  const src = readFileSync(FILE, "utf8");

  it("does not declare a KNOWN_SOURCES array literal", () => {
    // Comments mentioning the historical name are allowed; an assignment
    // (`const KNOWN_SOURCES = [...]`) is not.
    const declRe = /\b(const|let|var)\s+KNOWN_SOURCES\s*[:=]/;
    expect(
      declRe.test(src),
      "ReturnTemplateEditor.tsx must not redeclare KNOWN_SOURCES — drive options from usePackTokens()",
    ).toBe(false);
  });

  it("consumes the pack token registry via usePackTokens()", () => {
    expect(
      src.includes("usePackTokens"),
      "ReturnTemplateEditor.tsx must import and call usePackTokens() so packs control their own column sources.",
    ).toBe(true);
  });

  it("does not hardcode country-specific statutory identifier paths", () => {
    const offenders = FORBIDDEN_LITERAL_TOKENS.filter((tok) =>
      src.includes(`"${tok}"`),
    );
    expect(
      offenders,
      `Country-specific statutory identifier paths must not appear in JSX/code. ` +
        `Add them as pack_token_registry rows tied to the pack instead.\n${offenders.join("\n")}`,
    ).toEqual([]);
  });
});
