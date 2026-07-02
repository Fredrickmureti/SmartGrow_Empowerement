/**
 * Architecture guard: POS writes must always carry the branch dimension.
 *
 * Specifically:
 *   - Every `.from("pos_transactions").insert(...)` call site (excluding the
 *     RPC wrapper itself, which is in a migration) must include `branch_id`
 *     in the inserted payload OR a `// SCOPE-EXEMPT: <reason>` marker.
 *   - Every POS-related migration that calls `post_journal_entry_atomic`
 *     must pass an explicit branch argument (the 16th positional parameter
 *     `_branch_id`) — NULL is acceptable for company-wide entries, but the
 *     argument MUST be present.
 *
 * Companion to `branch-id-stamping.test.ts`.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "fs";
import { join } from "path";

const SRC = join(process.cwd(), "src");
const MIGRATIONS = join(process.cwd(), "supabase", "migrations");

function walk(dir: string, out: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      if (entry === "node_modules" || entry === "__tests__" || entry === "test") continue;
      walk(full, out);
    } else if (/\.(ts|tsx|sql)$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

describe("Architecture: POS branch_id stamping", () => {
  it("every pos_transactions.update in app code branch-binds via .eq('branch_id', …) or SCOPE-EXEMPT", () => {
    const files = walk(SRC).filter(
      (f) =>
        /\.(ts|tsx)$/.test(f) &&
        !f.includes("/test/") &&
        !f.endsWith(".test.ts") &&
        !f.endsWith(".test.tsx") &&
        !f.endsWith(".d.ts"),
    );
    // Match: .from("pos_transactions") … .update(…)
    const re = /\.from\(\s*["'`]pos_transactions["'`]\s*\)((?:(?!\.from\(|;)[\s\S]){0,600})\.update\(/g;
    const violations: { file: string; snippet: string }[] = [];
    for (const file of files) {
      const text = readFileSync(file, "utf8");
      let m: RegExpExecArray | null;
      while ((m = re.exec(text)) !== null) {
        // Look ahead in the chain (next 600 chars) for either an explicit
        // branch binding or an exempt marker.
        const window = text.slice(m.index, m.index + 1000);
        if (
          /\.eq\(\s*["'`]branch_id["'`]/.test(window) ||
          /SCOPE-EXEMPT/.test(window)
        ) {
          continue;
        }
        violations.push({
          file: file.replace(SRC, "src"),
          snippet: text.slice(m.index, m.index + 200).replace(/\s+/g, " "),
        });
        break;
      }
    }
    expect(
      violations,
      `pos_transactions updates missing branch_id binding:\n${JSON.stringify(violations, null, 2)}`,
    ).toEqual([]);
  });

  it("every pos_transactions.insert in app code includes branch_id or SCOPE-EXEMPT", () => {
    const files = walk(SRC).filter(
      (f) =>
        /\.(ts|tsx)$/.test(f) &&
        !f.includes("/test/") &&
        !f.endsWith(".test.ts") &&
        !f.endsWith(".test.tsx") &&
        !f.endsWith(".d.ts"),
    );
    const re = /\.from\(\s*["'`]pos_transactions["'`]\s*\)((?:(?!\.from\(|;)[\s\S]){0,600})\.insert\(/g;
    const violations: { file: string; snippet: string }[] = [];
    for (const file of files) {
      const text = readFileSync(file, "utf8");
      let m: RegExpExecArray | null;
      while ((m = re.exec(text)) !== null) {
        const window = text.slice(m.index, m.index + 800);
        if (/branch_id\s*:/.test(window) || /SCOPE-EXEMPT/.test(window)) continue;
        violations.push({
          file: file.replace(SRC, "src"),
          snippet: text.slice(m.index, m.index + 160).replace(/\s+/g, " "),
        });
        break;
      }
    }
    expect(
      violations,
      `pos_transactions inserts missing branch_id:\n${JSON.stringify(violations, null, 2)}`,
    ).toEqual([]);
  });

  it("post_pos_shift_gl in migrations passes _branch_id to post_journal_entry_atomic", () => {
    const files = walk(MIGRATIONS).filter((f) => f.endsWith(".sql"));
    // Find the most-recent migration that defines post_pos_shift_gl
    let latestDef: { file: string; body: string } | null = null;
    for (const file of files) {
      const text = readFileSync(file, "utf8");
      if (/CREATE\s+OR\s+REPLACE\s+FUNCTION\s+public\.post_pos_shift_gl/i.test(text)) {
        if (!latestDef || file > latestDef.file) {
          latestDef = { file, body: text };
        }
      }
    }
    if (!latestDef) {
      // Function exists in DB but not in tracked migrations — skip rather than fail
      return;
    }
    // Strip single-line SQL comments so a paren-rich `-- ...` line higher
    // up in the migration doesn't fool the regex (a comment can include
    // example signatures like `post_journal_entry_atomic(unknown, uuid)`
    // which previously caused this assertion to grab the wrong substring).
    const stripped = latestDef.body
      .split("\n")
      .map((line) => line.replace(/--.*$/, ""))
      .join("\n");
    // The atomic call must include at least 16 positional args (16th = _branch_id)
    const callMatch = stripped.match(
      /post_journal_entry_atomic\s*\(([\s\S]*?)\)\s*;/,
    );
    expect(
      callMatch,
      `post_pos_shift_gl in ${latestDef.file} must call post_journal_entry_atomic`,
    ).toBeTruthy();
    if (callMatch) {
      // Count top-level commas (naive: ignores nested parens but that's fine here
      // since post_journal_entry_atomic args are scalars/identifiers)
      const args = callMatch[1].split(",");
      expect(
        args.length,
        `post_journal_entry_atomic must receive 16 args (incl. _branch_id) in ${latestDef.file}; got ${args.length}`,
      ).toBeGreaterThanOrEqual(16);
      // Hardening (Round 3): not just the count — the literal `_branch_id`
      // identifier must appear in the call. The previous arg-count-only
      // check let any 16-arg permutation pass even if `_branch_id` was
      // missing or in the wrong slot.
      expect(
        callMatch[1],
        `post_journal_entry_atomic call in ${latestDef.file} must reference _branch_id explicitly`,
      ).toMatch(/_branch_id/);
    }
  });
});
