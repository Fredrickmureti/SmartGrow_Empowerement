/**
 * Phase 4 · item 9 — Line-AST contract test.
 *
 * Enforces the ADR-0084 invariant: the three renderers (on-screen
 * MonospacePreview, thermal PDF, ESC/POS emitter) receive the *same*
 * `ReceiptLinesResult` from a *single* producer.
 *
 * The check is structural rather than runtime because the ESC/POS
 * emitter and PDF renderer are Deno modules that pull `pdf-lib` from
 * esm.sh and cannot be executed inside vitest. Structural equality is
 * still sufficient — if both consumers import the exact same
 * `ReceiptLinesResult` type from the exact same producer file, then by
 * construction they operate on the same AST.
 *
 * Fails if:
 *   - The producer signature of `buildReceiptLines` moves or its result
 *     type is redefined outside `receipt/lines.ts`.
 *   - Either consumer stops importing `ReceiptLinesResult` from the
 *     canonical producer.
 *   - A new file in the print/PDF/ESC-POS pipeline defines its own
 *     `ReceiptLinesResult` interface (parallel AST — the exact drift
 *     Phase 2 removed).
 */
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve, relative } from "node:path";

const ROOT = resolve(__dirname, "..", "..", "..");

const PRODUCER_SERVER = join(
  ROOT,
  "supabase/functions/_shared/receipt/lines.ts",
);
const PRODUCER_CLIENT = join(
  ROOT,
  "src/lib/receipt/preview/buildReceiptLines.ts",
);
const PDF_RENDERER = join(
  ROOT,
  "supabase/functions/_shared/receipt/pdf/renderThermalPdf.ts",
);
const ESCPOS_RENDERER = join(
  ROOT,
  "supabase/functions/_shared/escpos/renderLinesEscPos.ts",
);

function walk(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "dist" || entry.startsWith(".")) continue;
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, acc);
    else if (/\.(ts|tsx)$/.test(entry)) acc.push(full);
  }
  return acc;
}

describe("Phase 4 · Line-AST contract (ADR-0084)", () => {
  it("canonical producer exists on both server and client", () => {
    expect(statSync(PRODUCER_SERVER).isFile()).toBe(true);
    expect(statSync(PRODUCER_CLIENT).isFile()).toBe(true);
  });

  it("both server producer and the two backend renderers export/consume `ReceiptLinesResult`", () => {
    const producerText = readFileSync(PRODUCER_SERVER, "utf-8");
    expect(
      /export\s+(?:interface|type)\s+ReceiptLinesResult\b/.test(producerText),
      "ReceiptLinesResult must be exported from supabase/functions/_shared/receipt/lines.ts",
    ).toBe(true);

    const pdfText = readFileSync(PDF_RENDERER, "utf-8");
    expect(
      /from\s+["']\.\.\/lines\.ts["']/.test(pdfText),
      "renderThermalPdf.ts must import from '../lines.ts' (canonical producer)",
    ).toBe(true);
    expect(
      /ReceiptLinesResult/.test(pdfText),
      "renderThermalPdf.ts must consume ReceiptLinesResult",
    ).toBe(true);

    const escposText = readFileSync(ESCPOS_RENDERER, "utf-8");
    expect(
      /from\s+["']\.\.\/receipt\/lines\.ts["']/.test(escposText),
      "renderLinesEscPos.ts must import from '../receipt/lines.ts' (canonical producer)",
    ).toBe(true);
    expect(
      /ReceiptLinesResult/.test(escposText),
      "renderLinesEscPos.ts must consume ReceiptLinesResult",
    ).toBe(true);
  });

  it("no file outside the canonical producer redefines `ReceiptLinesResult`", () => {
    const searchRoots = [
      join(ROOT, "src"),
      join(ROOT, "supabase", "functions"),
    ];
    const files: string[] = [];
    for (const r of searchRoots) files.push(...walk(r));

    const offenders: string[] = [];
    const define = /(?:^|\s)(?:export\s+)?(?:interface|type)\s+ReceiptLinesResult\s*(?:=|extends|\{)/;

    for (const f of files) {
      if (f === PRODUCER_SERVER || f === PRODUCER_CLIENT) continue;
      if (/(?:_test|\.test)\.(?:ts|tsx)$/.test(f)) continue;
      const text = readFileSync(f, "utf-8");
      if (define.test(text)) {
        offenders.push(relative(ROOT, f));
      }
    }
    expect(
      offenders,
      `ReceiptLinesResult may only be defined by the canonical producer. Parallel definitions found:\n${offenders.join("\n")}`,
    ).toEqual([]);
  });
});
