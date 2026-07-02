/**
 * Parity guard: the edge function must keep its own copy of `nextDate`
 * byte-identical to `src/lib/projects/recurrenceRule.ts`. If you change one,
 * change both.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

function extractNextDateBody(src: string): string {
  const m = src.match(/function\s+nextDate[\s\S]*?\n\}/);
  if (!m) throw new Error("nextDate not found in source");
  return m[0].replace(/\s+/g, " ").trim();
}

describe("nextDate parity (edge fn ↔ src/lib)", () => {
  it("body matches between the edge function and the shared helper", () => {
    const edge = fs.readFileSync(
      path.resolve(__dirname, "../../../supabase/functions/generate-recurring-tasks/index.ts"),
      "utf8",
    );
    const lib = fs.readFileSync(
      path.resolve(__dirname, "../../../src/lib/projects/recurrenceRule.ts"),
      "utf8",
    );
    expect(extractNextDateBody(edge)).toBe(extractNextDateBody(lib));
  });
});