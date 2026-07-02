/**
 * Phase 4 P1.3 — input lineage architecture guard.
 *
 * Every `pushLine(` call inside the payroll engine MUST pass an
 * `input_ref` so the explainer, the PDF generator, and the drill-down
 * resolver (P4) can answer "where did this amount come from?".
 *
 * Concretely: every non-comment `pushLine(` invocation must either
 *   (a) pass a typed input_ref as the 10th positional argument, OR
 *   (b) carry a `// LINEAGE-EXEMPT: <reason>` comment on the line above.
 *
 * This is a static check — it greps the engine source and counts
 * arguments by counting top-level commas. Crude but sufficient: the
 * engine has a single emitter (`pushLine`) and only ~12 call sites.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const ENGINE = resolve(__dirname, "../../../supabase/functions/compute-payroll/index.ts");

function splitTopLevelArgs(src: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let buf = "";
  for (const ch of src) {
    if (ch === "(" || ch === "[" || ch === "{") depth++;
    else if (ch === ")" || ch === "]" || ch === "}") depth--;
    if (ch === "," && depth === 0) {
      out.push(buf.trim());
      buf = "";
    } else {
      buf += ch;
    }
  }
  if (buf.trim()) out.push(buf.trim());
  return out;
}

function extractPushLineArgs(source: string): string[][] {
  const calls: string[][] = [];
  const re = /pushLine\(/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source))) {
    const start = m.index + m[0].length;
    let depth = 1;
    let i = start;
    while (i < source.length && depth > 0) {
      const c = source[i];
      if (c === "(") depth++;
      else if (c === ")") depth--;
      if (depth === 0) break;
      i++;
    }
    if (depth === 0) {
      calls.push(splitTopLevelArgs(source.slice(start, i)));
    }
  }
  return calls;
}

describe("payslip line input lineage (Phase 4 P1.3)", () => {
  const src = readFileSync(ENGINE, "utf8");

  it("every pushLine() invocation passes an input_ref (10th arg) or is exempt", () => {
    const offending: string[] = [];
    const re = /pushLine\(/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(src))) {
      const callStart = m.index;
      // Skip the signature declaration ("const pushLine = (").
      const preceding = src.slice(Math.max(0, callStart - 40), callStart);
      if (/pushLine\s*=\s*$/.test(preceding) || /const\s+$/.test(preceding)) continue;
      // Exempt marker on the previous line.
      const lineStart = src.lastIndexOf("\n", callStart) + 1;
      const prevLineEnd = lineStart - 1;
      const prevLineStart = src.lastIndexOf("\n", prevLineEnd - 1) + 1;
      const prevLine = src.slice(prevLineStart, prevLineEnd);
      if (/LINEAGE-EXEMPT/.test(prevLine)) continue;
      // Walk forward from the opening paren to its matching close.
      const argsStart = callStart + m[0].length;
      let i = argsStart;
      let depth = 1;
      while (i < src.length && depth > 0) {
        const c = src[i];
        if (c === "(") depth++;
        else if (c === ")") depth--;
        if (depth === 0) break;
        i++;
      }
      const args = splitTopLevelArgs(src.slice(argsStart, i));
      if (args.length < 10) {
        const lineNo = src.slice(0, callStart).split("\n").length;
        const lineText = src.slice(lineStart, src.indexOf("\n", lineStart));
        offending.push(`L${lineNo} (args=${args.length}): ${lineText.trim().slice(0, 100)}`);
      }
    }
    expect(offending).toEqual([]);
  });


  it("input_ref helper is imported from the shared module", () => {
    expect(src).toMatch(/from\s+"\.\.\/_shared\/inputRef\.ts"/);
  });

  /**
   * Phase 4 P4 — close the loop: every `InputRefKind` declared in the
   * shared union must also be handled by the drill-down resolver. If a
   * future engine change adds a new kind without updating
   * `src/lib/payroll/payslipDrillDown.ts`, the next CI run fails here —
   * the explainer would otherwise silently render a non-clickable
   * "Source: …" row for the new kind and the audit chain would regress.
   *
   * Duplicated with `payslip-drill-down.test.ts` on purpose: that file
   * tests the *resolver*, this file tests the *contract between engine
   * and resolver*. Either guard alone could be deleted by accident.
   */
  it("every InputRefKind has a matching case in the drill-down resolver", () => {
    const sharedRef = readFileSync(
      resolve(__dirname, "../../../supabase/functions/_shared/inputRef.ts"),
      "utf8",
    );
    const resolver = readFileSync(
      resolve(__dirname, "../../lib/payroll/payslipDrillDown.ts"),
      "utf8",
    );
    const m = sharedRef.match(/export type InputRefKind\s*=\s*([^;]+);/);
    expect(m, "InputRefKind union missing from shared inputRef.ts").toBeTruthy();
    const kinds = (m![1].match(/"([^"]+)"/g) ?? []).map((s) => s.replace(/"/g, ""));
    const missing = kinds.filter((k) => !new RegExp(`case\\s+"${k}"\\s*:`).test(resolver));
    expect(missing, `Drill-down resolver missing cases: ${missing.join(", ")}`).toEqual([]);
  });
});
