/**
 * Architecture invariant: there is exactly ONE transport to the server
 * document renderer.
 *
 * `src/services/printing/pdfUtils.ts::callDocumentRenderer` owns the
 * endpoint URL, the auth shape, the `X-Print-Policy-*` header contract and
 * the error contract. Every render — PDF, ESC/POS, preview, POS test print —
 * comes through it, so preview and print can never drift apart.
 *
 * CSV/XLSX extracts are no longer an exception: they are `csv` / `xlsx`
 * mediums of the ONE rendering engine, projected from the same frozen
 * snapshot as the PDF, so `documentExport.ts` no longer names an endpoint
 * at all.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "fs";
import { join } from "path";

const ROOTS = ["src"];

/** Files allowed to name the renderer endpoint in executable code. */
const ALLOWED = new Set<string>([
  "src/services/printing/pdfUtils.ts",
]);

const SKIP_DIRS = new Set(["test", "__tests__", "node_modules"]);

function walk(dir: string): string[] {
  const out: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) {
      if (SKIP_DIRS.has(entry)) continue;
      out.push(...walk(p));
    } else if (/\.tsx?$/.test(entry)) {
      out.push(p);
    }
  }
  return out;
}

/** Strip comments so documentation references don't count as call sites. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

describe("document renderer single transport", () => {
  it("only the transport seam calls the generate-document endpoint", () => {
    const offenders: string[] = [];
    for (const root of ROOTS) {
      for (const file of walk(root)) {
        const normalised = file.replace(/\\/g, "/");
        if (ALLOWED.has(normalised)) continue;
        const code = stripComments(readFileSync(file, "utf8"));
        if (/functions\/v1\/generate-document|invoke\(\s*["'`]generate-document/.test(code)) {
          offenders.push(normalised);
        }
      }
    }
    expect(
      offenders,
      "These files call the document renderer directly instead of going " +
        "through pdfUtils. Route them through renderDocumentPreview / " +
        "renderDocumentBytesWithPolicy.\nOffenders:\n" + offenders.join("\n"),
    ).toEqual([]);
  });

  it("the preview dialog renders through PrintService, not raw HTTP", () => {
    const src = readFileSync("src/components/common/PrintPreviewDialog.tsx", "utf8");
    expect(src).toMatch(/renderDocumentPreview/);
    expect(stripComments(src)).not.toMatch(/\bfetch\s*\(/);
  });

  it("data exports render from the frozen snapshot, not a live re-read", () => {
    const src = stripComments(
      readFileSync("src/services/exports/documentExport.ts", "utf8"),
    );
    expect(src).toMatch(/resolveSourceDocumentRecordId/);
    expect(src).toMatch(/renderDocumentRecord/);
    expect(src).not.toMatch(/generate-document/);
  });
});
