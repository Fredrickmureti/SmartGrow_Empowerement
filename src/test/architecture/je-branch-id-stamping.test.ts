/**
 * Architecture guard: every direct insert into `journal_entries` from app
 * code must stamp `branch_id` (or be explicitly exempted with a comment).
 *
 * The canonical posting path (`useGLPosting.postToGL` → `post_journal_entry_atomic`)
 * already stamps the active branch. This test catches future regressions
 * where someone bypasses the helper and inserts a JE row directly.
 *
 * Exempt callers must add the marker comment within ~200 chars BEFORE
 * the `.from("journal_entries")` call:
 *   // SCOPE-EXEMPT: company-wide entry  (period close, retained earnings, etc.)
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "fs";
import { join } from "path";

const SRC = join(process.cwd(), "src");

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      if (entry === "node_modules" || entry === "test" || entry === "__tests__") continue;
      walk(full, out);
    } else if (/\.(ts|tsx)$/.test(entry) && !entry.endsWith(".d.ts")) {
      out.push(full);
    }
  }
  return out;
}

describe("Architecture: journal_entries inserts must stamp branch_id", () => {
  it("every direct .from('journal_entries').insert(...) carries branch_id or SCOPE-EXEMPT", () => {
    const files = walk(SRC);
    const violations: { file: string; snippet: string }[] = [];
    const re = /\.from\(\s*["'`]journal_entries["'`]\s*\)((?:(?!\.from\(|;)[\s\S]){0,800})\.insert\(/g;

    for (const file of files) {
      if (file.includes("/test/") || /\.test\.tsx?$/.test(file)) continue;
      const text = readFileSync(file, "utf8");
      let m: RegExpExecArray | null;
      while ((m = re.exec(text)) !== null) {
        const before = text.slice(Math.max(0, m.index - 200), m.index);
        if (/SCOPE-EXEMPT/.test(before)) continue;
        const window = text.slice(m.index, m.index + 1000);
        if (/branch_id\s*:/.test(window)) continue;
        violations.push({
          file: file.replace(SRC, "src"),
          snippet: text.slice(m.index, m.index + 160).replace(/\s+/g, " "),
        });
      }
    }

    expect(
      violations,
      `Found journal_entries inserts missing branch_id:\n${JSON.stringify(violations, null, 2)}`,
    ).toEqual([]);
  });
});
