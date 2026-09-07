/**
 * Architecture guard (ADR-0020): no auto-posted journal entry may carry
 * a raw UUID in its `_description` or `_reference` text. Every poster
 * must use the source document's human-readable number (invoice_number,
 * adjustment_number, receipt_number, shift_number, delivery_number, …).
 *
 * This test scans every SQL migration and fails the build if it finds
 * a `_description := ... || <ident>_id::text` or
 * `_reference := ... || <ident>_id::text` pattern — the exact regression
 * that produced "Stock adjustment a59edeec-...".
 *
 * Exempt occurrences (rare — e.g. a debug-only narration) must add the
 * marker comment within the same line:
 *   -- ADR-0020-EXEMPT: <reason>
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "fs";
import { join } from "path";

const MIGRATIONS = join(process.cwd(), "supabase", "migrations");

// ADR-0020 was adopted on 2026-05-22 (Wave 12). Earlier migrations contain
// the regression we are fixing; their function definitions have already
// been superseded by the Wave 12 migration. Only enforce the rule against
// migrations at or after the cutoff so we don't fail the build on the
// historical record we are intentionally preserving.
const CUTOFF = "20260522222833";

describe("Architecture (ADR-0020): JE description/reference must not embed UUIDs", () => {
  it("no migration concatenates *_id::text into _description or _reference", () => {
    const files = readdirSync(MIGRATIONS)
      .filter((f) => f.endsWith(".sql"))
      .filter((f) => f.slice(0, CUTOFF.length) >= CUTOFF)
      .map((f) => join(MIGRATIONS, f));

    // matches: _description := <anything> || <ident>_id::text
    //      or: _reference   := <anything> || <ident>_id::text
    const re =
      /_(?:description|reference)\s*:?=[^;\n]*\|\|[^;\n]*[A-Za-z_]+_id\s*::\s*text/g;

    // `COALESCE(v_adj_number, 'ADJ-' || LEFT(p_adjustment_id::text, 8))`
    // satisfies ADR-0020: the human-readable number is preferred and the id
    // only appears as a last-resort fallback when the document carries no
    // number at all. Only an unconditional id concatenation is a violation.
    const numberPreferred =
      /coalesce\s*\(\s*[A-Za-z_.]*_number\b[^;\n]*[A-Za-z_]+_id\s*::\s*text/i;

    const violations: { file: string; line: number; snippet: string }[] = [];

    for (const file of files) {
      const text = readFileSync(file, "utf8");
      const lines = text.split("\n");
      lines.forEach((line, idx) => {
        if (!re.test(line)) {
          re.lastIndex = 0;
          return;
        }
        re.lastIndex = 0;
        if (/ADR-0020-EXEMPT/.test(line)) return;
        if (numberPreferred.test(line)) return;

        violations.push({
          file: file.replace(process.cwd() + "/", ""),
          line: idx + 1,
          snippet: line.trim().slice(0, 200),
        });
      });
    }

    expect(
      violations,
      `Found auto-posted JE narrations that embed a UUID:\n${JSON.stringify(
        violations,
        null,
        2,
      )}\n\nUse the source document's human-readable number instead (e.g. adjustment_number, invoice_number, receipt_number).`,
    ).toEqual([]);
  });
});
